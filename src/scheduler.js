import { config } from './config.js';
import { logger } from './logger.js';
import { getFailureBackoffMs } from './vk.js';
import { getAuctionPosts } from './auctionPosts.js';
import {
  getMoscowDateParts,
  getMoscowDateKey
} from './auctionTime.js';
import {
  getWorkerState, saveWorkerState, registerPollingPost,
  getPollingAuctions, getAuctionsMissingPollState
} from './db.js';
import { pollAuction } from './auctionPolling.js';
import {
  runAuctionReminders,
  sendManualHappySantaReminders,
  cleanupFinishedAuctionReminders
} from './reminderService.js';

const VK_REMINDER_SCHEDULE_TYPE = 'vk_reminder';
const HAPPY_SANTA_ONLY_SCHEDULE_TYPE = 'happy_santa_only';

let isRunning = false;
let isReminderRunning = false;
let lastReminderRunKey = null;
let firstPoll = true;

export async function tick(now = new Date()) {
  if (isRunning) {
    logger.warn('Previous tick is still running, skipping.');
    return [];
  }

  isRunning = true;
  let auctionPosts = [];

  try {
    const discovery = getWorkerState('auction_discovery') || { nextAt: 0, failures: 0 };
    if (now.getTime() >= discovery.nextAt) {
      try {
        const recoverPostIds = getAuctionsMissingPollState().map((auction) => auction.post_id);
        const discovered = await getAuctionPosts({ recoverPostIds });
        for (const post of discovered) registerPollingPost(post);
        saveWorkerState('auction_discovery', {
          nextAt: now.getTime() + config.auctionDiscoveryMs, failures: 0, lastSuccess: now.toISOString()
        });
        logger.info(`Auction discovery: ${discovered.length} post(s); next in ${config.auctionDiscoveryMs / 1000}s`);
      } catch (error) {
        saveWorkerState('auction_discovery', {
          ...discovery, failures: discovery.failures + 1,
          nextAt: Math.max(now.getTime() + getFailureBackoffMs(discovery.failures + 1), error.retryAt || 0)
        });
        logger.warn('Auction discovery deferred; continuing saved auctions:', error.message);
      }
    }
    const auctions = getPollingAuctions();
    auctionPosts = auctions.map((auction) => JSON.parse(auction.post_json));
    const reconciledPosts = [];
    for (let i = 0; i < auctions.length; i += 1) {
      const auction = auctions[i];
      if (auction.poll_status === 'stopped') continue;
      const resumeNow = firstPoll && !auction.consecutive_failures;
      if (!resumeNow && auction.next_poll_at && Date.parse(auction.next_poll_at) > now.getTime()) continue;
      if (await pollAuction(auctionPosts[i], { now })) {
        reconciledPosts.push(auctionPosts[i]);
      }
    }
    firstPoll = false;
    if (!config.rebuildMode && reconciledPosts.length) {
      await cleanupFinishedAuctionReminders(now, reconciledPosts, { onlyProvidedPosts: true });
    }
    saveWorkerState('worker_health', { lastTick: new Date().toISOString() });
    return auctionPosts;
  } catch (error) {
    logger.error('Tick failed:', error.message);
    return auctionPosts;
  } finally {
    isRunning = false;
  }
}

export function getReminderSchedule(now = new Date()) {
  const parts = getMoscowDateParts(now);

  if (parts.hour === 8) {
    return {
      type: VK_REMINDER_SCHEDULE_TYPE,
      scheduleTime: '08:00'
    };
  }

  if (parts.hour === 17) {
    return {
      type: VK_REMINDER_SCHEDULE_TYPE,
      scheduleTime: '17:00'
    };
  }

  if (parts.hour === 19 && parts.minute === 35) {
    return {
      type: HAPPY_SANTA_ONLY_SCHEDULE_TYPE,
      scheduleTime: '19:35'
    };
  }

  return null;
}

export async function reminderTick(now = new Date()) {
  const schedule = getReminderSchedule(now);
  if (!schedule) return;

  const runKey = `${getMoscowDateKey(now)} ${schedule.type} ${schedule.scheduleTime}`;
  if (runKey === lastReminderRunKey) {
    return;
  }

  if (isReminderRunning) {
    logger.warn('Previous reminder tick is still running, skipping.');
    return;
  }

  isReminderRunning = true;
  lastReminderRunKey = runKey;

  try {
    if (schedule.type === HAPPY_SANTA_ONLY_SCHEDULE_TYPE) {
      logger.info(`Starting Happy Santa-only reminder run: ${runKey}`);
      const results = await sendManualHappySantaReminders({ now });
      const sent = results.filter((result) => result.sent).length;
      const failed = results.filter((result) => result.error).length;
      const skipped = results.length - sent - failed;

      logger.info(
        `Happy Santa-only reminder run complete: sent=${sent}, skipped=${skipped}, failed=${failed}`
      );
      return;
    }

    logger.info(`Starting auction reminder run: ${runKey}`);
    await runAuctionReminders(schedule.scheduleTime, now);
  } catch (error) {
    logger.error('Reminder tick failed:', error.message);
  } finally {
    isReminderRunning = false;
  }
}

export function startScheduler() {
  logger.info('Starting scheduler.');
  let stopped = false;
  let pollTimer;
  let reminderTimer;
  let pollTask = Promise.resolve();
  let reminderTask = Promise.resolve();
  async function pollLoop() {
    await tick();
    if (stopped) return;
    const nextTimes = getPollingAuctions()
      .filter((auction) => auction.poll_status !== 'stopped' && auction.next_poll_at)
      .map((auction) => Date.parse(auction.next_poll_at));
    nextTimes.push(getWorkerState('auction_discovery')?.nextAt || Date.now() + 30000);
    const delay = Math.max(1000, Math.min(30000, ...nextTimes.map((time) => time - Date.now())));
    pollTimer = setTimeout(runPoll, delay);
  }
  function runPoll() {
    pollTask = pollLoop().catch((error) => {
      logger.error('Polling loop failed:', error.message);
      if (!stopped) pollTimer = setTimeout(runPoll, config.vkBackoffMaxMs);
    });
  }
  function runReminder() {
    if (isReminderRunning) return;
    reminderTask = reminderTick().catch((error) => logger.error('Reminder loop failed:', error.message));
  }
  runPoll();

  if (config.auctionRemindersEnabled) {
    logger.info(
      'Starting auction reminder scheduler at 08:00 and 17:00 Europe/Moscow; Happy Santa-only at 19:35 Europe/Moscow.'
    );
    runReminder();
    reminderTimer = setInterval(runReminder, 60 * 1000);
  } else {
    logger.info('Auction reminder scheduler is disabled.');
  }
  return async function stopScheduler() {
    stopped = true;
    clearTimeout(pollTimer);
    clearInterval(reminderTimer);
    await Promise.allSettled([pollTask, reminderTask]);
    logger.info('Scheduler stopped; completed work is persisted.');
  };
}
