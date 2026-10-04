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

export const config = {
  vkServiceToken: process.env.VK_SERVICE_TOKEN || '',
  vkGroupToken: process.env.VK_GROUP_TOKEN || '',
  vkApiVersion: process.env.VK_API_VERSION || '5.199',
  vkGroupId: Number(process.env.VK_GROUP_ID || 0),
  vkTimeoutMs: Number(process.env.VK_TIMEOUT_MS || 15000),
  vkRequestSpacingMs: Number(process.env.VK_REQUEST_SPACING_MS || 400),
  vkBackoffBaseMs: Number(process.env.VK_BACKOFF_BASE_MS || 15000),
  vkBackoffMaxMs: Number(process.env.VK_BACKOFF_MAX_MS || 300000),

  pollInitialMs: Number(process.env.POLL_INITIAL_MS || 600000),
  pollInitialWindowMs: Number(process.env.POLL_INITIAL_WINDOW_MS || 10800000),
  pollQuietMs: Number(process.env.POLL_QUIET_MS || 3600000),
  pollDayMs: Number(process.env.POLL_DAY_MS || 1800000),
  pollActiveMs: Number(process.env.POLL_ACTIVE_MS || 600000),
  pollApproachingMs: Number(process.env.POLL_APPROACHING_MS || 120000),
  pollClosingMs: Number(process.env.POLL_CLOSING_MS || 60000),
  pollDeadlineMs: Number(process.env.POLL_DEADLINE_MS || 15000),
  pollGraceMs: Number(process.env.POLL_GRACE_MS || 300000),
  pollGraceWindowMs: Number(process.env.POLL_GRACE_WINDOW_MS || 1800000),
  pollApproachingWindowMs: Number(process.env.POLL_APPROACHING_WINDOW_MS || 7200000),
  pollClosingWindowMs: Number(process.env.POLL_CLOSING_WINDOW_MS || 1800000),
  pollDeadlineWindowMs: Number(process.env.POLL_DEADLINE_WINDOW_MS || 300000),
  auctionDiscoveryMs: Number(process.env.AUCTION_DISCOVERY_MS || 600000),
  auctionDiscoveryStart: process.env.AUCTION_DISCOVERY_START || '18:01',
  auctionDiscoveryEnd: process.env.AUCTION_DISCOVERY_END || '20:11',
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
  reminderPublisher: process.env.REMINDER_PUBLISHER || 'group-token',
  happySantaApiBaseUrl: process.env.HS_API_BASE_URL || 'https://broadcast.vkforms.ru/api/v2',
  happySantaApiToken: process.env.HS_API_TOKEN || '',
  happySantaAuctionListId: Number(process.env.HS_AUCTION_LIST_ID || 0),
  happySantaTimeoutMs: Number(process.env.HS_TIMEOUT_MS || 10000),
};
