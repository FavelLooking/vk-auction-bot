import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_ENV_VARS = [
  'VK_USER_TOKEN',
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

  console.log('Configuration OK');
  return true;
}
