import dotenv from 'dotenv';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

dotenv.config({ path: join(appRoot, '.env') });

function resolveConfigPath(value) {
  if (!value) {
    return value;
  }

  return isAbsolute(value) ? value : resolve(appRoot, value);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  vkUserToken: required('VK_USER_TOKEN'),
  vkGroupToken: required('VK_GROUP_TOKEN'),
  vkApiVersion: process.env.VK_API_VERSION || '5.199',
  vkGroupId: Number(required('VK_GROUP_ID')),

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  pollFastIntervalMs: Number(process.env.POLL_FAST_INTERVAL_MS || process.env.POLL_INTERVAL_MS || 15000),
  pollNormalIntervalMs: Number(process.env.POLL_NORMAL_INTERVAL_MS || 60000),
  pollNightIntervalMs: Number(process.env.POLL_NIGHT_INTERVAL_MS || 300000),
  pollFastAfterPostMs: Number(process.env.POLL_FAST_AFTER_POST_MS || 2 * 60 * 60 * 1000),
  pollClosingSoonMs: Number(process.env.POLL_CLOSING_SOON_MS || 30 * 60 * 1000),
  autoReply: String(process.env.AUTO_REPLY || 'false') === 'true',
  useLmStudio: String(process.env.USE_LM_STUDIO || 'false') === 'true',
  lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
  lmStudioModel: process.env.LM_STUDIO_MODEL || 'qwen/qwen3-8b',
  sqlitePath: resolveConfigPath(process.env.SQLITE_PATH || './auction.db'),
  sqliteBackupDir: resolveConfigPath(process.env.SQLITE_BACKUP_DIR) || join(dirname(resolveConfigPath(process.env.SQLITE_PATH || './auction.db')), 'backups'),
  minBidStep: Number(process.env.MIN_BID_STEP || 50),
  allowEqualBid: String(process.env.ALLOW_EQUAL_BID || 'false') === 'true',
  dryRun: String(process.env.DRY_RUN || 'false') === 'true',

  auctionPostSearchLimit: Number(process.env.AUCTION_POST_SEARCH_LIMIT || 10),
  auctionTag: (process.env.AUCTION_TAG || '#cp_аукцион').toLowerCase(),
  singleAuctionTag: (process.env.SINGLE_AUCTION_TAG || '#CP_Аукцион_Одиночный').toLowerCase(),
  onlyPinned: String(process.env.ONLY_PINNED || 'false') === 'true',

  skipOldOnFirstSeen: String(process.env.SKIP_OLD_ON_FIRST_SEEN || 'true') === 'true',
  replyDelayMs: Number(process.env.REPLY_DELAY_MS || 700),
  rebuildMode: String(process.env.REBUILD_MODE || 'false') === 'true',
  auctionRemindersEnabled: String(process.env.AUCTION_REMINDERS_ENABLED || 'true') === 'true',
  happySantaApiBaseUrl: process.env.HS_API_BASE_URL || 'https://broadcast.vkforms.ru/api/v2',
  happySantaApiToken: process.env.HS_API_TOKEN || '',
  happySantaAuctionListId: Number(process.env.HS_AUCTION_LIST_ID || 0),
  happySantaTimeoutMs: Number(process.env.HS_TIMEOUT_MS || 10000),
};
