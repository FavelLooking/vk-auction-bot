import { sendManualHappySantaReminders } from '../src/reminderService.js';
import { config } from '../src/config.js';

function getBroadcastId(response) {
  return response?.id
    ?? response?.broadcast_id
    ?? response?.broadcast?.id
    ?? response?.data?.id
    ?? response?.data?.broadcast_id
    ?? response?.data?.broadcast?.id
    ?? response?.response?.id
    ?? null;
}

function parseNowArg(argv) {
  const arg = argv.find((value) => value.startsWith('--now='));
  if (!arg) return null;

  const rawValue = arg.slice('--now='.length);
  const date = new Date(rawValue);

  if (!rawValue || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --now value: ${rawValue || '<empty>'}`);
  }

  return date;
}

function parseForceArg(argv) {
  return argv.includes('--force');
}

async function main() {
  const argv = process.argv.slice(2);
  const now = parseNowArg(argv);
  const force = parseForceArg(argv);

  console.log('Happy Santa manual reminder send');
  console.log(`Mailing list id: ${config.happySantaAuctionListId || 'not configured'}`);
  if (now) {
    console.log(`Eligibility time: ${now.toISOString()}`);
  }
  if (force) {
    console.log('Duplicate protection: force override');
  }

  const results = await sendManualHappySantaReminders({
    now: now ?? new Date(),
    force
  });
  const sent = results.filter((result) => result.sent);
  const skipped = results.filter((result) => !result.sent && !result.error);
  const failed = results.filter((result) => result.error);

  for (const result of sent) {
    const broadcastId = getBroadcastId(result.response);
    console.log(
      `SUCCESS post=${result.postId} key=${result.reminderKey ?? '-'} list=${config.happySantaAuctionListId} broadcast=${broadcastId ?? 'unknown'} attachments=${result.attachments.length}`
    );
  }

  for (const result of skipped) {
    console.log(
      `SKIPPED post=${result.postId ?? '-'} key=${result.reminderKey ?? '-'} list=${config.happySantaAuctionListId || '-'} attachments=${result.attachments?.length ?? 0} reason=${result.reason || 'unknown'}`
    );
  }

  for (const result of failed) {
    console.error(
      `ERROR post=${result.postId ?? '-'} key=${result.reminderKey ?? '-'} list=${config.happySantaAuctionListId || '-'} attachments=${result.attachments?.length ?? 0} ${result.error.message}`
    );
  }

  console.log(`Done. sent=${sent.length}, skipped=${skipped.length}, failed=${failed.length}`);

  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('ERROR', error.message);
  process.exitCode = 1;
});
