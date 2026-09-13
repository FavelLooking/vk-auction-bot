import { config } from './config.js';

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

function isSelectedAuctionPost(post) {
  return (!config.onlyPinned || post.is_pinned) && isAuctionPost(post);
}

export async function getAuctionPosts({ recoverPostIds = [] } = {}) {
  const { getWallPosts, getWallPostsByIds } = await import('./vk.js');
  const response = await getWallPosts({
    groupId: config.vkGroupId,
    count: config.auctionPostSearchLimit
  });

  const items = new Map(response.items.map((post) => [post.id, post]));
  const missing = recoverPostIds.filter((id) => !items.has(id));
  for (let offset = 0; offset < missing.length; offset += 100) {
    const recovered = await getWallPostsByIds({ groupId: config.vkGroupId, postIds: missing.slice(offset, offset + 100) });
    for (const post of Array.isArray(recovered) ? recovered : recovered.items) items.set(post.id, post);
  }
  return [...items.values()].filter(isSelectedAuctionPost);
}
