import { config } from './config.js';
import { getWallPosts } from './vk.js';

const CANONICAL_SINGLE_AUCTION_TAG = '#CP_Аукцион_Одиночный'.toLowerCase();

function normalizePostText(text) {
  return String(text || '')
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .toLowerCase();
}

export function isAuctionPost(post) {
  const text = normalizePostText(post.text);
  if (!text) return false;

  return text.includes(config.auctionTag);
}

export function isSingleAuctionPost(post) {
  const text = normalizePostText(post.text);
  if (!text) return false;

  const tags = new Set([
    normalizePostText(config.singleAuctionTag),
    CANONICAL_SINGLE_AUCTION_TAG
  ]);

  return [...tags].some((tag) => tag && text.includes(tag));
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
