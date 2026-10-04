import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

dotenv.config({ path: join(appRoot, '.env') });

const REQUIRED_ENV_VARS = [
  'VK_SERVICE_TOKEN',
  'VK_GROUP_TOKEN',
  'VK_GROUP_ID',
  'SQLITE_PATH',
  'AUTO_REPLY',
  'AUCTION_REMINDERS_ENABLED',
  'REBUILD_MODE',
  'HS_API_TOKEN',
  'HS_AUCTION_LIST_ID'
];

export function validateRequiredConfig(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((name) => !String(env[name] || '').trim());

  if (missing.length) {
    console.error('Configuration error');
    console.error('');
    console.error('Missing:');
    console.error('');

    for (const name of missing) {
      console.error(name);
    }

    console.error('');
    console.error('Bot startup aborted.');

    return false;
  }

  const invalid = [];
  for (const name of ['VK_GROUP_ID', 'HS_AUCTION_LIST_ID']) {
    if (!Number.isSafeInteger(Number(env[name])) || Number(env[name]) <= 0) invalid.push(name);
  }
  for (const name of ['AUTO_REPLY', 'AUCTION_REMINDERS_ENABLED', 'REBUILD_MODE', 'DRY_RUN']) {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name])) invalid.push(name);
  }
  for (const name of [
    'VK_TIMEOUT_MS', 'VK_REQUEST_SPACING_MS', 'VK_BACKOFF_BASE_MS', 'VK_BACKOFF_MAX_MS',
    'POLL_INITIAL_MS', 'POLL_INITIAL_WINDOW_MS', 'POLL_QUIET_MS', 'POLL_DAY_MS',
    'POLL_ACTIVE_MS', 'POLL_APPROACHING_MS', 'POLL_CLOSING_MS',
    'POLL_DEADLINE_MS', 'POLL_GRACE_MS', 'POLL_GRACE_WINDOW_MS',
    'POLL_APPROACHING_WINDOW_MS', 'POLL_CLOSING_WINDOW_MS', 'POLL_DEADLINE_WINDOW_MS',
    'AUCTION_DISCOVERY_MS'
  ]) {
    if (env[name] !== undefined && (!Number.isSafeInteger(Number(env[name])) || Number(env[name]) <= 0)) {
      invalid.push(name);
    }
  }
  for (const name of ['AUCTION_DISCOVERY_START', 'AUCTION_DISCOVERY_END']) {
    if (env[name] !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(env[name])) invalid.push(name);
  }
  if (env.AUCTION_DISCOVERY_START && env.AUCTION_DISCOVERY_END
    && env.AUCTION_DISCOVERY_START >= env.AUCTION_DISCOVERY_END) {
    invalid.push('AUCTION_DISCOVERY_START/AUCTION_DISCOVERY_END');
  }
  if (env.REMINDER_PUBLISHER && !['group-token', 'package-only', 'disabled'].includes(env.REMINDER_PUBLISHER)) {
    invalid.push('REMINDER_PUBLISHER (use group-token, package-only or disabled)');
  }
  if (invalid.length) {
    console.error(`Configuration error\n\nInvalid:\n${invalid.join('\n')}\n\nBot startup aborted.`);
    return false;
  }

  console.log('Configuration OK');
  return true;
}
