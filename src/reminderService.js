import { config } from './config.js';
import {
  getOrCreateAuction,
  getCurrentSummary,
  getAuctionReminderRecord,
  saveAuctionReminderRecord,
  getActiveAuctionReminderRecords,
  markAuctionReminderDeleted,
  getHappySantaBroadcastRecord,
  claimHappySantaBroadcast,
  markHappySantaBroadcastSent,
  clearHappySantaBroadcastClaim
} from './db.js';
import { getAuctionPosts, isSingleAuctionPost } from './auctionPosts.js';
import {
  getAuctionEffectiveEndIso,
  getMoscowDateKey
} from './auctionTime.js';
import { logger } from './logger.js';
import { createWallPost, deleteWallPost } from './vk.js';
import { sendHappySantaReminder } from './services/notifications/happySantaChannel.js';

const MORNING_SCHEDULE_TIME = '08:00';
const EVENING_SCHEDULE_TIME = '17:00';
const HAPPY_SANTA_25M_REMINDER_TYPE = 'happy_santa_25m';

function getAuctionLink(postId) {
  return `https://vk.com/wall-${Math.abs(config.vkGroupId)}_${postId}`;
}

function getHappySantaReminderKey(postId) {
  return `${HAPPY_SANTA_25M_REMINDER_TYPE}:${postId}`;
}

function getFirstPhotoAttachment(post) {
  const photo = (post.attachments || []).find((attachment) => attachment.type === 'photo')?.photo;
  if (!photo?.owner_id || !photo?.id) return null;

  return `photo${photo.owner_id}_${photo.id}`;
}

function buildReminderSummary(summaryRows) {
  return summaryRows
    .map((row) => {
      const name = row.leader_name ? ` (${row.leader_name})` : '';
      return `🟢 ${row.lot_number} - ${row.current_price} ₽${name}`;
    })
    .join('\n');
}

function buildHappySantaSummary(summaryRows) {
  return summaryRows
    .map((row) => `🟢 ${row.lot_number} - ${row.current_price} ₽`)
    .join('\n');
}

function joinMessageLines(lines) {
  const normalized = [];

  for (const line of lines) {
    const value = String(line ?? '').trimEnd();

    if (!value && (!normalized.length || !normalized[normalized.length - 1])) {
      continue;
    }

    normalized.push(value);
  }

  while (normalized.length && !normalized[normalized.length - 1]) {
    normalized.pop();
  }

  return normalized.join('\n');
}

function buildMorningReminderText({ postId, summaryRows }) {
  return [
    '🌞 Доброе утро!',
    '',
    'Сегодня в 20:00 завершается аукцион.',
    '',
    'Текущие ставки:',
    '',
    buildReminderSummary(summaryRows),
    '',
    'Все фотографии находятся в аукционном посте 👇',
    '',
    '----------------------------------',
    getAuctionLink(postId)
  ].join('\n');
}

function buildEveningReminderText({ postId, summaryRows }) {
  return [
    '⏰ До завершения аукциона осталось всего несколько часов!',
    '',
    'Текущие ставки:',
    '',
    buildReminderSummary(summaryRows),
    '',
    '----------------------------------',
    'Сделать ставку можно в текущем аукционе:',
    getAuctionLink(postId)
  ].join('\n');
}

function buildSingleAuctionMorningReminderText({ postId, summaryRows }) {
  return [
    '🔥 Напоминаем, что аукцион продолжается!',
    '',
    'Текущая ставка:',
    '',
    buildReminderSummary(summaryRows),
    '',
    '----------------------------------',
    '',
    'Сделать ставку можно здесь:',
    getAuctionLink(postId)
  ].join('\n');
}

function buildSingleAuctionEveningReminderText({ postId, summaryRows }) {
  return [
    '⏰ До завершения аукциона осталось совсем немного времени!',
    '',
    'Текущая ставка:',
    '',
    buildReminderSummary(summaryRows),
    '',
    '----------------------------------',
    '',
    'Сделать ставку можно здесь:',
    getAuctionLink(postId)
  ].join('\n');
}

function buildReminderText({ postId, summaryRows, scheduleTime, isSingleAuction }) {
  if (scheduleTime === MORNING_SCHEDULE_TIME) {
    if (isSingleAuction) {
      return buildSingleAuctionMorningReminderText({ postId, summaryRows });
    }

    return buildMorningReminderText({ postId, summaryRows });
  }

  if (scheduleTime === EVENING_SCHEDULE_TIME) {
    if (isSingleAuction) {
      return buildSingleAuctionEveningReminderText({ postId, summaryRows });
    }

    return buildEveningReminderText({ postId, summaryRows });
  }

  throw new Error(`Unsupported reminder schedule time: ${scheduleTime}`);
}

function countSummaryLots(summaryRows) {
  return new Set(summaryRows.map((row) => row.lot_number)).size;
}

function isHappySantaSingleLotAuction(post, summaryRows = []) {
  return isSingleAuctionPost(post) || countSummaryLots(summaryRows) === 1;
}

function getHappySantaEndingTitle(post, summaryRows) {
  return isHappySantaSingleLotAuction(post, summaryRows)
    ? '✨ Через 25 минут завершается аукцион ✨'
    : '✨ Через 25 минут завершаются аукционы ✨';
}

function getHappySantaNewAuctionTitle(post) {
  return isSingleAuctionPost(post)
    ? 'А ещё мы запустили новый аукцион'
    : 'А ещё мы запустили новые аукционы';
}

function buildAdaptiveHappySantaReminderText({ endingPost, newPost, summaryRows = [] }) {
  const lines = [];

  if (endingPost && summaryRows.length) {
    lines.push(
      getHappySantaEndingTitle(endingPost, summaryRows),
      '',
      getAuctionLink(endingPost.id),
      '',
      buildHappySantaSummary(summaryRows)
    );
  }

  if (newPost) {
    lines.push(
      '',
      getHappySantaNewAuctionTitle(newPost),
      '',
      getAuctionLink(newPost.id)
    );
  }

  return joinMessageLines(lines);
}

function buildHappySantaReminderText({ endingPost, newPost, summaryRows }) {
  return buildAdaptiveHappySantaReminderText({ endingPost, newPost, summaryRows });
}

function findNewAuctionPost({ auctionPosts, endingPost }) {
  return auctionPosts
    .filter((post) => post.id !== endingPost.id)
    .sort((a, b) => (b.date || 0) - (a.date || 0))[0] || null;
}

function buildHappySantaAttachments({ endingPost, newPost }) {
  return [
    endingPost ? getFirstPhotoAttachment(endingPost) : null,
    newPost ? getFirstPhotoAttachment(newPost) : null
  ].filter(Boolean);
}

export async function sendHappySantaReminderForAuction({
  post,
  auction,
  auctionPosts,
  now = new Date(),
  force = false
}) {
  const summaryRows = getCurrentSummary(auction.id);

  if (!summaryRows.length) {
    return {
      sent: false,
      reason: 'no_current_bids',
      postId: post.id
    };
  }

  const endIso = getAuctionEffectiveEndIso(auction.post_date, summaryRows);

  if (!isAuctionActive(endIso, now) || !isAuctionEndingToday(auction.post_date, endIso, now)) {
    return {
      sent: false,
      reason: 'not_active_or_not_ending_today',
      postId: post.id
    };
  }

  const newPost = findNewAuctionPost({ auctionPosts, endingPost: post });
  const message = buildHappySantaReminderText({
    endingPost: post,
    newPost,
    summaryRows
  });
  const attachments = buildHappySantaAttachments({
    endingPost: post,
    newPost
  });
  const reminderKey = getHappySantaReminderKey(post.id);

  if (!message) {
    logger.info('Happy Santa skipped: nothing to send');
    return {
      sent: false,
      reason: 'nothing_to_send',
      postId: post.id,
      reminderKey,
      message,
      attachments
    };
  }

  if (!force) {
    const existingBroadcast = getHappySantaBroadcastRecord(reminderKey);

    if (existingBroadcast) {
      logger.info('Happy Santa skipped: already sent');
      logger.info(`Key: ${reminderKey}`);

      return {
        sent: false,
        reason: 'already_sent',
        postId: post.id,
        reminderKey,
        message,
        attachments
      };
    }

    if (!claimHappySantaBroadcast(reminderKey)) {
      logger.info('Happy Santa skipped: already sent');
      logger.info(`Key: ${reminderKey}`);

      return {
        sent: false,
        reason: 'already_sent',
        postId: post.id,
        reminderKey,
        message,
        attachments
      };
    }
  }

  let result;

  try {
    result = await sendHappySantaReminder({
      message,
      attachments
    });
  } catch (error) {
    if (!force) {
      clearHappySantaBroadcastClaim(reminderKey);
    }

    throw error;
  }

  if (!result.sent) {
    if (!force) {
      clearHappySantaBroadcastClaim(reminderKey);
    }

    return {
      ...result,
      postId: post.id,
      reminderKey,
      message,
      attachments
    };
  }

  markHappySantaBroadcastSent({
    reminderKey,
    responseJson: JSON.stringify(result.response ?? null)
  });

  logger.info('Happy Santa sent');
  logger.info(`Key: ${reminderKey}`);

  return {
    ...result,
    postId: post.id,
    reminderKey,
    message,
    attachments
  };
}

function isAuctionEndingToday(postDateIso, endIso, now = new Date()) {
  if (!postDateIso || !endIso) return false;

  return getMoscowDateKey(endIso) === getMoscowDateKey(now);
}

function isAuctionActive(endIso, now = new Date()) {
  return Boolean(endIso) && new Date(endIso).getTime() > now.getTime();
}

async function publishReminder({ post, auction, scheduleTime, auctionPosts }) {
  const existingReminder = getAuctionReminderRecord({
    auctionId: auction.id,
    scheduleTime
  });

  if (existingReminder) {
    saveAuctionReminderRecord({
      auctionId: auction.id,
      scheduleTime,
      reminderPostId: existingReminder.reminder_post_id
    });

    logger.info(
      `Reminder already tracked for post ${post.id} at ${scheduleTime}; skipping duplicate post.`
    );
    return;
  }

  const summaryRows = getCurrentSummary(auction.id);

  if (!summaryRows.length) {
    logger.info(`Skipping reminder for post ${post.id}: no current bids found.`);
    return;
  }

  const endIso = getAuctionEffectiveEndIso(auction.post_date, summaryRows);

  if (!isAuctionActive(endIso) || !isAuctionEndingToday(auction.post_date, endIso)) {
    return;
  }

  const reminderText = buildReminderText({
    postId: post.id,
    summaryRows,
    scheduleTime,
    isSingleAuction: isSingleAuctionPost(post)
  });
  const attachment = getFirstPhotoAttachment(post);

  if (config.dryRun) {
    logger.info(`[DRY_RUN] Reminder for post ${post.id}:\n${reminderText}`);
    saveAuctionReminderRecord({
      auctionId: auction.id,
      scheduleTime,
      reminderPostId: null
    });
    return;
  }

  const result = await createWallPost({
    groupId: config.vkGroupId,
    message: reminderText,
    attachments: attachment ? [attachment] : []
  });

  saveAuctionReminderRecord({
    auctionId: auction.id,
    scheduleTime,
    reminderPostId: result.post_id ?? null
  });

  logger.info(`Reminder published for auction post ${post.id}: reminder post ${result.post_id}`);
}

export async function sendManualHappySantaReminders({ now = new Date(), force = false } = {}) {
  const auctionPosts = await getAuctionPosts();
  const results = [];
  let eligibleAuction = null;

  for (const post of auctionPosts) {
    const postDateIso = post.date ? new Date(post.date * 1000).toISOString() : null;
    const auction = getOrCreateAuction(config.vkGroupId, post.id, postDateIso, null);
    const summaryRows = getCurrentSummary(auction.id);
    const endIso = getAuctionEffectiveEndIso(auction.post_date, summaryRows);

    if (
      summaryRows.length
      && isAuctionActive(endIso, now)
      && isAuctionEndingToday(auction.post_date, endIso, now)
    ) {
      eligibleAuction = {
        post,
        auction
      };
      break;
    }

    results.push({
      sent: false,
      reason: 'not_active_or_not_ending_today',
      postId: post.id
    });
  }

  if (!eligibleAuction) {
    logger.info('Happy Santa skipped: no ending auction');
    return results;
  }

  results.push(
    await sendHappySantaReminderForAuction({
      post: eligibleAuction.post,
      auction: eligibleAuction.auction,
      auctionPosts,
      now,
      force
    })
  );

  return results;
}

export async function runAuctionReminders(scheduleTime, now = new Date()) {
  const scheduleDate = getMoscowDateKey(now);
  const auctionPosts = await getAuctionPosts();

  if (!auctionPosts.length) {
    logger.info(`No auction posts found for reminder run ${scheduleDate} ${scheduleTime}.`);
    return;
  }

  for (const post of auctionPosts) {
    try {
      const postDateIso = post.date ? new Date(post.date * 1000).toISOString() : null;
      const auction = getOrCreateAuction(config.vkGroupId, post.id, postDateIso, null);

      await publishReminder({
        post,
        auction,
        scheduleTime,
        auctionPosts
      });
    } catch (error) {
      logger.error(`Failed to publish reminder for post ${post.id}:`, error.message);
    }
  }
}

export async function cleanupFinishedAuctionReminders(now = new Date()) {
  const reminders = getActiveAuctionReminderRecords();

  for (const reminder of reminders) {
    try {
      const summaryRows = getCurrentSummary(reminder.auction_id);
      const endIso = getAuctionEffectiveEndIso(reminder.post_date, summaryRows);

      if (!endIso || new Date(endIso).getTime() > now.getTime()) {
        continue;
      }

      if (reminder.reminder_post_id && !config.dryRun) {
        try {
          await deleteWallPost({
            groupId: config.vkGroupId,
            postId: reminder.reminder_post_id
          });
        } catch {}
      }

      markAuctionReminderDeleted(reminder.id);
      logger.info(
        `Reminder ${reminder.id} marked deleted for finished auction post ${reminder.post_id}.`
      );
    } catch (error) {
      logger.error(`Failed to cleanup reminder ${reminder.id}:`, error.message);
    }
  }
}
