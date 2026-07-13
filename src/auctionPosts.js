import { config } from './config.js';
import { getWallPosts } from './vk.js';

function normalizePostText(text) {
  return String(text || '').toLowerCase();
}

export function isAuctionPost(post) {
  const text = normalizePostText(post.text);
  if (!text) return false;

  return text.includes(config.auctionTag);
}

export function isSingleAuctionPost(post) {
  const text = normalizePostText(post.text);
  if (!text) return false;

  return text.includes(config.singleAuctionTag);
}

export async function getAuctionPosts() {
  const response = await getWallPosts({
    groupId: config.vkGroupId,
    count: config.auctionPostSearchLimit
  });

  const items = response.items || [];

  return items.filter((post) => {
    if (config.onlyPinned && !post.is_pinned) {
      return false;
    }

    return isAuctionPost(post);
  });
}
