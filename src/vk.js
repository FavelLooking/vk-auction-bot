import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';
import { getWorkerState, saveWorkerState, beginVkApiUsage, finishVkApiUsage } from './db.js';

const vk = axios.create({ baseURL: 'https://api.vk.com/method/' });
const TEMPORARY_CODES = new Set([1, 6, 9, 10, 29]);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK', 'ERR_BAD_RESPONSE']);

export class VkApiError extends Error {
  constructor(message, { code = null, method = null, temporary = false, retryAt = null } = {}) {
    super(message);
    this.name = 'VkApiError';
    this.code = code;
    this.method = method;
    this.temporary = temporary;
    this.retryAt = retryAt;
  }
}

export function getFailureBackoffMs(failures, settings = config) {
  return Math.min(settings.vkBackoffBaseMs * 2 ** Math.min(20, Math.max(0, failures - 1)), settings.vkBackoffMaxMs);
}

export function isTemporaryVkError(error) {
  return Boolean(error?.temporary || TEMPORARY_CODES.has(error?.code));
}

export function getVkBackoffUntil(method = 'users.get', tokenType = 'service') {
  return getWorkerState(`vk:${tokenType}:${method}`)?.until || 0;
}

// Dependencies are injectable so tests cannot accidentally contact VK.
export function createVkCaller({
  transport = vk, settings = config,
  readState = getWorkerState, writeState = saveWorkerState,
  beginUsage = beginVkApiUsage, finishUsage = finishVkApiUsage,
  log = logger, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let queue = Promise.resolve();
  let lastRequestAt = null;

  async function request(method, params, { tokenType, operation, validate }) {
    const token = tokenType === 'service' ? settings.vkServiceToken : settings.vkGroupToken;
    if (!token) throw new VkApiError(`VK ${tokenType} token is missing for ${method}`, { method });
    const key = `vk:${tokenType}:${method}`;
    const state = readState(key) || { failures: 0, until: 0 };
    if (now() < state.until) {
      throw new VkApiError(`VK backoff active: ${method} (${tokenType})`, {
        method, temporary: true, retryAt: state.until
      });
    }
    if (lastRequestAt !== null) {
      const waitMs = settings.vkRequestSpacingMs - (now() - lastRequestAt);
      if (waitMs > 0) await sleep(waitMs);
    }
    const usageId = beginUsage({ timestamp: new Date(now()).toISOString(), operation, method, tokenType });
    lastRequestAt = now();
    let failure = null;
    let result;
    try {
      const response = await transport.get(method, {
        timeout: settings.vkTimeoutMs,
        params: { ...params, access_token: token, v: settings.vkApiVersion }
      });
      const data = response.data;
      if (data?.error) {
        const code = Number(data.error.error_code);
        // VK errors may echo access_token in request_params: never log the raw body.
        throw new VkApiError(`VK API error ${code} in ${method}`, {
          code, method, temporary: TEMPORARY_CODES.has(code)
        });
      }
      if (!data || !Object.hasOwn(data, 'response') || (validate && !validate(data.response))) {
        throw new VkApiError(`Invalid VK response in ${method}`, { method, temporary: true });
      }
      result = data.response;
    } catch (error) {
      const networkCode = NETWORK_CODES.has(error.code) ? error.code : 'network_or_invalid_response';
      failure = error instanceof VkApiError ? error : new VkApiError(
        `VK network/HTTP failure in ${method} (${networkCode})`, { method, temporary: true }
      );
      failure.errorKind = failure.code === null ? networkCode : 'vk_error';
    }
    if (failure) {
      const failures = state.failures + 1;
      const delay = failure.temporary ? getFailureBackoffMs(failures, settings) : settings.vkBackoffMaxMs;
      const until = now() + delay;
      writeState(key, { failures, until });
      finishUsage(usageId, {
        success: false, vkErrorCode: failure.code,
        errorKind: failure.errorKind
      });
      failure.retryAt = until;
      log.warn(`VK ${failure.code === 9 ? 'Flood control' : 'request failed'}, backoff ${Math.round(delay / 1000)}s; method=${method}, token=${tokenType}, failures=${failures}, code=${failure.code ?? '-'}, kind=${failure.errorKind}`);
      throw failure;
    }
    finishUsage(usageId, { success: true });
    if (state.failures) {
      writeState(key, { failures: 0, until: 0 });
      log.info(`Backoff reset: ${method} (${tokenType})`);
    }
    return result;
  }
  return (method, params = {}, options) => {
    const pending = queue.then(() => request(method, params, options));
    queue = pending.catch(() => {});
    return pending;
  };
}

const callVk = createVkCaller();
const hasItems = (response) => Array.isArray(response?.items);

export async function getWallPosts({ groupId, count = 10 }) {
  return callVk('wall.get', { owner_id: -Math.abs(groupId), count }, {
    tokenType: 'service', operation: 'auction_discovery', validate: hasItems
  });
}

export async function getWallPostsByIds({ groupId, postIds }) {
  return callVk('wall.getById', {
    posts: postIds.map((id) => `${-Math.abs(groupId)}_${id}`).join(',')
  }, { tokenType: 'service', operation: 'auction_recovery', validate: (value) => Array.isArray(value) || hasItems(value) });
}

export async function getWallComments({ groupId, postId, offset = 0, count = 100, sort = 'asc', startCommentId }) {
  const params = {
    owner_id: -Math.abs(groupId), post_id: postId,
    need_likes: 0, preview_length: 0, offset, count, sort, thread_items_count: 0
  };
  if (startCommentId !== undefined) params.start_comment_id = startCommentId;
  return callVk('wall.getComments', params, {
    tokenType: 'service', operation: 'bid_poll', validate: hasItems
  });
}

export async function getUserInfo(userIds = []) {
  const ids = [...new Set(userIds.filter((id) => id > 0))];
  const users = [];
  for (let offset = 0; offset < ids.length; offset += 1000) {
    users.push(...await callVk('users.get', {
      user_ids: ids.slice(offset, offset + 1000).join(','), fields: 'domain'
    }, { tokenType: 'service', operation: 'participant_names', validate: Array.isArray }));
  }
  return users;
}

export async function createComment({ groupId, postId, message, replyToCommentId, operation = 'bid_reply' }) {
  const params = { owner_id: -Math.abs(groupId), post_id: postId, from_group: Math.abs(groupId), message };
  if (replyToCommentId) params.reply_to_comment = replyToCommentId;
  return callVk('wall.createComment', params, {
    tokenType: 'group', operation, validate: (value) => Number.isSafeInteger(value?.comment_id)
  });
}

export async function createWallPost({ groupId, message, attachments = [] }) {
  if (config.dryRun || config.reminderPublisher !== 'group-token') {
    throw new Error('wall.post is disabled in dry-run/package-only mode');
  }
  const params = { owner_id: -Math.abs(groupId), from_group: 1, message };
  if (attachments.length) params.attachments = attachments.join(',');
  return callVk('wall.post', params, {
    tokenType: 'group', operation: 'reminder', validate: (value) => Number.isSafeInteger(value?.post_id)
  });
}

export async function deleteComment({ groupId, commentId }) {
  return callVk('wall.deleteComment', { owner_id: -Math.abs(groupId), comment_id: commentId }, {
    tokenType: 'group', operation: 'summary_delete', validate: (value) => value === 1
  });
}

export async function deleteWallPost({ groupId, postId }) {
  return callVk('wall.delete', { owner_id: -Math.abs(groupId), post_id: postId }, {
    tokenType: 'group', operation: 'legacy_reminder_cleanup', validate: (value) => value === 1
  });
}
