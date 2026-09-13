import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';

const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const REQUIRED_ENV_VARS = [
  'VK_SERVICE_TOKEN',
  'VK_GROUP_TOKEN',
  'VK_GROUP_ID'
];

function getPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getMoscowParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function getNextMoscowRun(hour, minute, now = new Date()) {
  const parts = getMoscowParts(now);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const targetMinutes = hour * 60 + minute;
  const localDate = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day)
  ));

  if (currentMinutes >= targetMinutes) {
    localDate.setUTCDate(localDate.getUTCDate() + 1);
  }

  return new Date(Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    hour - 3,
    minute,
    0,
    0
  )).toISOString();
}

function getConfigWarnings() {
  const warnings = [];

  if (Object.keys(process.env).some((name) => /^POLL_(INTERVAL_MS|FAST_|NORMAL_|NIGHT_|CLOSING_SOON_MS)/.test(name))) {
    warnings.push('Legacy polling variables are ignored; configure the new POLL_*_MS settings documented in README.md');
  }

  for (const name of REQUIRED_ENV_VARS) {
    if (!process.env[name]) {
      warnings.push(`${name} is not configured`);
    }
  }

  if (!config.happySantaApiToken) {
    warnings.push('HS_API_TOKEN is not configured; Happy Santa broadcasts are disabled');
  }

  if (!config.happySantaAuctionListId) {
    warnings.push('HS_AUCTION_LIST_ID is not configured; Happy Santa broadcasts are disabled');
  }

  return warnings;
}

export function logStartupDiagnostics() {
  const happySantaEnabled = Boolean(config.happySantaApiToken && config.happySantaAuctionListId);
  const packageOnly = config.dryRun || ['package-only', 'disabled'].includes(config.reminderPublisher);
  const reminderMode = packageOnly ? 'package only' : 'VK wall via group token';
  const warnings = getConfigWarnings();

  db.prepare('SELECT 1').get();

  logger.info('==============================');
  logger.info('Auction Bot Startup');
  logger.info('==============================');
  logger.info(`Version: ${getPackageVersion()}`);
  logger.info(`Node.js: ${process.version}`);
  logger.info('');
  logger.info('SQLite: OK');
  logger.info(`DB: ${config.sqlitePath}`);
  logger.info('');
  logger.info(`VK Group: -${Math.abs(config.vkGroupId)}`);
  logger.info('');
  logger.info('Polling: enabled');
  logger.info('VK reads: service token; comments: group token');
  logger.info(`Polling intervals (s): quiet=${config.pollQuietMs / 1000}, active=${config.pollActiveMs / 1000}, approaching=${config.pollApproachingMs / 1000}, closing=${config.pollClosingMs / 1000}, deadline=${config.pollDeadlineMs / 1000}, grace=${config.pollGraceMs / 1000}`);
  logger.info(`Auto Reply: ${config.autoReply ? 'enabled' : 'disabled'}`);
  logger.info(`Reminder Scheduler: ${config.auctionRemindersEnabled ? 'enabled' : 'disabled'}`);
  logger.info(`Reminder publisher: ${reminderMode}${config.dryRun ? ' (DRY_RUN)' : ''}`);
  logger.info('');
  logger.info(`Happy Santa: ${happySantaEnabled ? 'enabled' : 'disabled'}`);
  logger.info(`Mailing List: ${config.happySantaAuctionListId || 'not configured'}`);
  logger.info('');
  logger.info(`Timezone: ${process.env.TZ || MOSCOW_TIME_ZONE}`);
  logger.info('');
  logger.info('Next reminder:');
  logger.info(`08:00 -> ${getNextMoscowRun(8, 0)} (${reminderMode})`);
  logger.info(`17:00 -> ${getNextMoscowRun(17, 0)} (${reminderMode})`);
  logger.info(`19:35 -> ${getNextMoscowRun(19, 35)}`);

  if (warnings.length) {
    logger.warn('Configuration warnings:');
    for (const warning of warnings) {
      logger.warn(`- ${warning}`);
    }
  }

  logger.info('');
  logger.info('Startup complete.');
}
