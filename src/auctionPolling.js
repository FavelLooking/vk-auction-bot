import { config } from './config.js';
import { getAuctionBaseEndIso } from './auctionTime.js';
import { isSingleAuctionPost } from './auctionPosts.js';
import { filterSingleAuctionSummaryRows } from './singleAuctionParser.js';
import { getWallComments, getFailureBackoffMs, VkApiError } from './vk.js';
import {
  registerPollingPost, getAuctionPollState, getCurrentSummary,
  saveSuccessfulPoll, savePollSchedule, savePollFailure
} from './db.js';
import { processAuctionComments, printCurrentSummary, finalizeExpiredLots } from './auctionService.js';
import { logger } from './logger.js';

// Read backwards from a stable comment ID, then apply the complete batch forwards.
// Never persist a page offset: deleting a comment would shift every later offset.
export async function collectNewComments({ groupId, postId, lastCommentId = 0 }, readComments = getWallComments) {
  const comments = new Map();
  let startCommentId;
  while (true) {
    const response = await readComments({ groupId, postId, count: 100, sort: 'desc', startCommentId });
    if (!Array.isArray(response?.items)) {
      throw new VkApiError('Invalid comment page', { method: 'wall.getComments', temporary: true });
    }
    const page = response.items;
    if (!page.length) break;
    if (page.some((comment) => !Number.isSafeInteger(comment.id) || comment.id <= 0)) {
      throw new VkApiError('Comment page contains an invalid ID', { method: 'wall.getComments', temporary: true });
    }
    for (const comment of page) {
      if (comment.id > lastCommentId) {
        comments.set(comment.id, comment.deleted || !Number.isFinite(comment.date) || !Number.isFinite(comment.from_id)
          ? { ...comment, text: '' } : comment);
      }
    }
    const oldestId = Math.min(...page.map((comment) => comment.id));
    if (oldestId <= lastCommentId || page.length < 100) break;
    if (startCommentId !== undefined && oldestId >= startCommentId) {
      throw new VkApiError('Comment pagination made no progress', { method: 'wall.getComments', temporary: true });
    }
    // Include the anchor and deduplicate it locally; no assumption about a deleted anchor.
    startCommentId = oldestId;
  }
  const items = [...comments.values()].sort((a, b) => (a.date || 0) - (b.date || 0) || a.id - b.id);
  const latest = items.reduce((best, comment) => !best || comment.id > best.id ? comment : best, null);
  return { comments: items, lastCommentId: latest?.id ?? lastCommentId, lastCommentDate: latest?.date ?? null };
}

export function getPollingPlan({ postDate, summaryRows = [], lastSuccessfulPoll = null }, now = new Date(), settings = config) {
  const baseIso = getAuctionBaseEndIso(postDate);
  if (!baseIso) return { intervalMs: settings.pollQuietMs, reason: 'missing post date', status: 'active', nextBoundary: null };
  const baseEnd = Date.parse(baseIso);
  const nowMs = now.getTime();
  const openRows = summaryRows.filter((row) => !row.is_closed);
  const lotEnd = (row) => row.ends_at ? Date.parse(row.ends_at) : baseEnd;
  const lastEnd = Math.max(baseEnd, ...summaryRows.map(lotEnd));
  const graceEnd = lastEnd + settings.pollGraceWindowMs;
  if (nowMs >= lastEnd && !openRows.length) {
    const stopped = lastSuccessfulPoll && Date.parse(lastSuccessfulPoll) >= graceEnd;
    return {
      intervalMs: settings.pollGraceMs, reason: stopped ? 'reconciled; polling stopped' : 'post-end reconciliation',
      status: stopped ? 'stopped' : 'reconciling', nextBoundary: graceEnd > nowMs ? graceEnd : null
    };
  }
  const nextEnd = openRows.length ? Math.min(...openRows.map(lotEnd)) : baseEnd;
  const remaining = nextEnd - nowMs;
  const phases = [
    [settings.pollDeadlineWindowMs, settings.pollDeadlineMs, 'deadline / extension'],
    [settings.pollClosingWindowMs, settings.pollClosingMs, 'closing soon'],
    [settings.pollApproachingWindowMs, settings.pollApproachingMs, 'approaching end'],
    [settings.pollActiveWindowMs, settings.pollActiveMs, 'active period']
  ];
  const phase = phases.find(([window]) => remaining <= window);
  const boundaries = phases.map(([window]) => nextEnd - window).filter((time) => time > nowMs);
  return {
    intervalMs: phase?.[1] ?? settings.pollQuietMs,
    reason: phase?.[2] ?? 'quiet period', status: 'active',
    nextBoundary: boundaries.length ? Math.min(...boundaries) : null
  };
}

export function getVisiblePollingRows(auctionId, post) {
  const rows = getCurrentSummary(auctionId);
  return isSingleAuctionPost(post) ? filterSingleAuctionSummaryRows(rows) : rows;
}

export async function pollAuction(post, {
  now = new Date(), readComments = getWallComments,
  processComments = processAuctionComments, finalize = finalizeExpiredLots
} = {}) {
  const auction = registerPollingPost(post);
  const state = getAuctionPollState(auction.id);
  if (state.status === 'stopped') return false;
  try {
    const batch = await collectNewComments({
      groupId: config.vkGroupId, postId: post.id, lastCommentId: state.last_comment_id
    }, readComments);
    await processComments({ postId: post.id, postDate: post.date,
      isSingleAuction: isSingleAuctionPost(post), comments: batch.comments });
    // Bid rows and processed_comments are committed first. A crash before this
    // cursor update safely re-reads the batch; processed_comments prevents replay.
    saveSuccessfulPoll({ auctionId: auction.id, lastCommentId: batch.lastCommentId,
      lastCommentDate: batch.lastCommentDate, startedAt: now.toISOString() });
    if (!config.rebuildMode) {
      await finalize({ eligiblePostIds: new Set([post.id]), now,
        singleAuctionPostIds: new Set(isSingleAuctionPost(post) ? [post.id] : []) });
    }
    const plan = getPollingPlan({ postDate: auction.post_date,
      summaryRows: getVisiblePollingRows(auction.id, post), lastSuccessfulPoll: now.toISOString() }, now);
    savePollSchedule({ auctionId: auction.id, status: plan.status,
      nextPollAt: plan.status === 'stopped' ? null : new Date(Math.min(
        now.getTime() + plan.intervalMs, plan.nextBoundary ?? Infinity
      )).toISOString() });
    logger.info(`Poll interval: ${Math.round(plan.intervalMs / 1000)}s (${plan.reason}); post=${post.id}, new_comments=${batch.comments.length}, cursor=${batch.lastCommentId}`);
    if (batch.comments.length) printCurrentSummary(post.id, post.date, { isSingleAuction: isSingleAuctionPost(post) });
    return true;
  } catch (error) {
    const delay = getFailureBackoffMs(state.consecutive_failures + 1);
    const retryAt = Math.max(now.getTime() + delay, error.retryAt || 0);
    savePollFailure({ auctionId: auction.id, nextPollAt: new Date(retryAt).toISOString(), errorCode: error.code });
    logger.warn(`Auction poll deferred: post=${post.id}, failures=${state.consecutive_failures + 1}, retry=${new Date(retryAt).toISOString()}; ${error.message}`);
    return false;
  }
}
