import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

const vk = axios.create({
  baseURL: 'https://api.vk.com/method/'
});

let consecutiveTemporaryErrors = 0;
let backoffUntil = 0;
const BASE_BACKOFF_MS = 15 * 1000;
const MAX_BACKOFF_MS = 300 * 1000;

export class VkApiError extends Error {
  constructor(message, { code = null, method = null, temporary = false } = {}) {
    super(message);
    this.name = 'VkApiError';
    this.code = code;
    this.method = method;
    this.temporary = temporary;
  }
}

function getBackoffMs() {
  return Math.min(
    BASE_BACKOFF_MS * 2 ** Math.max(0, consecutiveTemporaryErrors - 1),
    MAX_BACKOFF_MS
  );
}

function applyBackoff(reason) {
  consecutiveTemporaryErrors += 1;
  const backoffMs = getBackoffMs();
  backoffUntil = Date.now() + backoffMs;

  if (reason === 'flood') {
    logger.warn(`VK Flood control, backoff ${Math.round(backoffMs / 1000)}s`);
  } else {
    logger.warn(`VK temporary error, backoff ${Math.round(backoffMs / 1000)}s`);
  }
}

function resetBackoff() {
  if (!consecutiveTemporaryErrors && !backoffUntil) {
    return;
  }

  consecutiveTemporaryErrors = 0;
  backoffUntil = 0;
  logger.info('Backoff reset');
}

export function isTemporaryVkError(error) {
  return Boolean(error?.temporary || error?.code === 9);
}

export function getVkBackoffUntil() {
  return backoffUntil;
}

async function callVk(method, params = {}, token) {
  if (!token) {
    throw new Error(`VK token is missing for method ${method}`);
  }

  if (Date.now() < backoffUntil) {
    throw new VkApiError(`VK API backoff active for method ${method}`, {
      method,
      temporary: true
    });
  }

  let response;

  try {
    response = await vk.get(method, {
      params: {
        access_token: token,
        v: config.vkApiVersion,
        ...params
      }
    });
  } catch (error) {
    applyBackoff('network');
    throw new VkApiError(`VK network error in ${method}: ${error.message}`, {
      method,
      temporary: true
    });
  }

  if (response.data.error) {
    const vkError = response.data.error;
    const isFloodControl = vkError.error_code === 9;

    if (isFloodControl) {
      applyBackoff('flood');
    }

    throw new VkApiError(`VK API error: ${JSON.stringify(vkError)}`, {
      code: vkError.error_code,
      method,
      temporary: isFloodControl
    });
  }

  resetBackoff();
  return response.data.response;
}

// Чтение постов
export async function getWallPosts({ groupId, count = 10 }) {
  return callVk(
    'wall.get',
    {
      owner_id: -Math.abs(groupId),
      count
    },
    config.vkUserToken
  );
}

// Чтение комментариев
export async function getWallComments({
  groupId,
  postId,
  offset = 0,
  count = 100,
  sort = 'asc'
}) {
  return callVk(
    'wall.getComments',
    {
      owner_id: -Math.abs(groupId),
      post_id: postId,
      need_likes: 0,
      preview_length: 0,
      offset,
      count,
      sort,
      thread_items_count: 10
    },
    config.vkUserToken
  );
}

// Информация о пользователях
export async function getUserInfo(userIds = []) {
  if (!userIds.length) return [];

  const ids = userIds.filter((id) => id > 0).join(',');
  if (!ids) return [];

  return callVk(
    'users.get',
    {
      user_ids: ids,
      fields: 'domain'
    },
    config.vkUserToken
  );
}

// Публикация комментария / ответа от имени группы
export async function createComment({
  groupId,
  postId,
  message,
  replyToCommentId
}) {
  const params = {
    owner_id: -Math.abs(groupId),
    post_id: postId,
    from_group: 1,
    message
  };

  if (replyToCommentId) {
    params.reply_to_comment = replyToCommentId;
  }

  return callVk('wall.createComment', params, config.vkGroupToken);
}

export async function createWallPost({
  groupId,
  message,
  attachments = []
}) {
  const params = {
    owner_id: -Math.abs(groupId),
    from_group: 1,
    message
  };

  if (attachments.length) {
    params.attachments = attachments.join(',');
  }

  return callVk('wall.post', params, config.vkGroupToken);
}

// Удаление комментария
export async function deleteComment({ groupId, commentId }) {
  return callVk(
    'wall.deleteComment',
    {
      owner_id: -Math.abs(groupId),
      comment_id: commentId
    },
    config.vkUserToken
  );
}

export async function deleteWallPost({ groupId, postId }) {
  const params = {
    owner_id: -Math.abs(groupId),
    post_id: postId
  };

  try {
    return await callVk('wall.delete', params, config.vkGroupToken);
  } catch (error) {
    return callVk('wall.delete', params, config.vkUserToken);
  }
}
