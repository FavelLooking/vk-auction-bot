import { config } from './config.js';
import { logger } from './logger.js';
import { getWallComments, isTemporaryVkError } from './vk.js';
import { getAuctionPosts, isSingleAuctionPost } from './auctionPosts.js';
import {
  getAuctionEffectiveEndIso,
  getMoscowDateParts,
  getMoscowDateKey
} from './auctionTime.js';
import { getAuctionByGroupPost, getCurrentSummary } from './db.js';
import { filterSingleAuctionSummaryRows } from './singleAuctionParser.js';
import {
  processAuctionComments,
  printCurrentSummary,
  finalizeExpiredLots
} from './auctionService.js';
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
let lastLoggedPollInterval = null;

async function processSinglePost(post) {
  const response = await getWallComments({
    groupId: config.vkGroupId,
    postId: post.id,
    count: 100,
    sort: 'asc'
  });

  const comments = response.items || [];

  await processAuctionComments({
    postId: post.id,
    postDate: post.date,
    isSingleAuction: isSingleAuctionPost(post),
    comments
  });

  printCurrentSummary(post.id, post.date, {
    isSingleAuction: isSingleAuctionPost(post)
  });
}

export async function tick() {
  if (isRunning) {
    logger.warn('Previous tick is still running, skipping.');
    return [];
  }

  isRunning = true;
  let auctionPosts = [];

  try {
    auctionPosts = await getAuctionPosts();

    if (!auctionPosts.length) {
      logger.info('No auction posts found.');
      return auctionPosts;
    }

    logger.info(
      `Found ${auctionPosts.length} auction post(s): ${auctionPosts.map((p) => p.id).join(', ')}`
    );

    for (const post of auctionPosts) {
      try {
        await processSinglePost(post);
      } catch (error) {
        if (isTemporaryVkError(error)) {
          logger.warn(`Skipped VK request while processing post ${post.id}:`, error.message);
        } else {
          logger.error(`Failed to process post ${post.id}:`, error.message);
        }
      }
    }

    if (!config.rebuildMode) {
      await finalizeExpiredLots({
        singleAuctionPostIds: new Set(
          auctionPosts
            .filter((post) => isSingleAuctionPost(post))
            .map((post) => post.id)
        )
      });
      try {
        await cleanupFinishedAuctionReminders(new Date(), auctionPosts);
      } catch (error) {
        logger.error('Reminder cleanup failed:', error.message);
      }
    }
    return auctionPosts;
  } catch (error) {
    if (isTemporaryVkError(error)) {
      logger.warn('Skipped VK request during auction tick:', error.message);
    } else {
      logger.error('Tick failed:', error.message);
    }
    return auctionPosts;
  } finally {
    isRunning = false;
  }
}

function formatIntervalLabel(ms) {
  return `${Math.round(ms / 1000)}s`;
}

function getPostDateMs(post) {
  return post.date ? post.date * 1000 : null;
}

function getPostEffectiveEndMs(post) {
  const postDateMs = getPostDateMs(post);
  if (!postDateMs) return null;

  const postDateIso = new Date(postDateMs).toISOString();
  const auction = getAuctionByGroupPost({
    groupId: config.vkGroupId,
    postId: post.id
  });
  const summaryRows = auction
    ? (
        isSingleAuctionPost(post)
          ? filterSingleAuctionSummaryRows(getCurrentSummary(auction.id))
          : getCurrentSummary(auction.id)
      )
    : [];
  const endIso = getAuctionEffectiveEndIso(postDateIso, summaryRows);

  return endIso ? new Date(endIso).getTime() : null;
}

function getAdaptivePollInterval(auctionPosts, now = new Date()) {
  const moscow = getMoscowDateParts(now);

  if (moscow.hour >= 0 && moscow.hour < 7) {
    return {
      intervalMs: config.pollNightIntervalMs,
      reason: 'night mode'
    };
  }

  const nowMs = now.getTime();

  for (const post of auctionPosts) {
    const postDateMs = getPostDateMs(post);

    if (postDateMs && nowMs - postDateMs <= config.pollFastAfterPostMs) {
      return {
        intervalMs: config.pollFastIntervalMs,
        reason: 'new auction'
      };
    }

    const endMs = getPostEffectiveEndMs(post);

    if (endMs && endMs > nowMs && endMs - nowMs <= config.pollClosingSoonMs) {
      return {
        intervalMs: config.pollFastIntervalMs,
        reason: 'closing soon'
      };
    }
  }

  return {
    intervalMs: config.pollNormalIntervalMs,
    reason: 'normal mode'
  };
}

function logPollInterval(intervalMs, reason) {
  if (lastLoggedPollInterval === intervalMs) {
    return;
  }

  lastLoggedPollInterval = intervalMs;
  logger.info(`Poll interval: ${formatIntervalLabel(intervalMs)} (${reason})`);
}

function getReminderSchedule(now = new Date()) {
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

  async function pollLoop() {
    const auctionPosts = await tick();
    const { intervalMs, reason } = getAdaptivePollInterval(auctionPosts);
    logPollInterval(intervalMs, reason);
    setTimeout(pollLoop, intervalMs);
  }

  pollLoop();

  if (config.auctionRemindersEnabled) {
    logger.info(
      'Starting auction reminder scheduler at 08:00 and 17:00 Europe/Moscow; Happy Santa-only at 19:35 Europe/Moscow.'
    );
    reminderTick();
    setInterval(() => reminderTick(), 60 * 1000);
  } else {
    logger.info('Auction reminder scheduler is disabled.');
  }
}
