import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { getMoscowDateKey } from './auctionTime.js';
import { isSingleAuctionPost } from './auctionPosts.js';

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function printApiUsage(db, now = new Date()) {
  if (!hasTable(db, 'vk_api_usage')) {
    console.log('API usage: no accounting data yet (migration not applied).');
    return;
  }
  const today = getMoscowDateKey(now);
  for (const [label, day] of [['Today', today], ['Current calendar month', `${today.slice(0, 7)}-01`]]) {
    const from = new Date(`${day}T00:00:00+03:00`).toISOString();
    const rows = db.prepare(`SELECT operation, method, token_type, COUNT(*) AS calls,
      SUM(success = 1) AS successful, SUM(success = 0) AS failed, SUM(success = -1) AS unknown
      FROM vk_api_usage WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY operation, method, token_type ORDER BY operation, method, token_type`).all(from, now.toISOString());
    console.log(`${label} (Europe/Moscow): ${rows.reduce((sum, row) => sum + row.calls, 0)} calls`);
    if (rows.length) console.table(rows);
  }
  console.log('Unknown = request was in flight at crash, or is still running. No quota is enforced.');
}

export function printAuctionStatus(db) {
  console.log(`SQLite: OK\nDB: ${config.sqlitePath}`);
  if (hasTable(db, 'worker_state')) {
    const health = db.prepare("SELECT value_json FROM worker_state WHERE key = 'worker_health'").get();
    console.log(`Last worker tick: ${health ? JSON.parse(health.value_json).lastTick : 'not recorded'}`);
  }
  if (!hasTable(db, 'auction_poll_state')) {
    console.log('Polling state: migration not applied yet.');
    return;
  }
  const auctions = db.prepare(`SELECT a.id, a.post_id, p.* FROM auctions a
    JOIN auction_poll_state p ON p.auction_id = a.id WHERE a.group_id = ?
    ORDER BY a.post_id DESC LIMIT 20`).all(config.vkGroupId);
  if (!auctions.length) console.log('No tracked auctions.');
  for (const auction of auctions) {
    const single = isSingleAuctionPost(JSON.parse(auction.post_json));
    const leaders = db.prepare(`SELECT lot_number, current_price, leader_name, leader_user_id, is_closed
      FROM lot_state WHERE auction_id = ? AND (? = 0 OR lot_number = 1) ORDER BY lot_number`)
      .all(auction.auction_id, single ? 1 : 0);
    console.log(`\nAuction: ${auction.auction_id}\nPost: ${auction.post_id}\nStatus: ${auction.status}`);
    if (leaders.length) console.table(leaders);
    else console.log('Current leader: none\nCurrent bid: none');
    console.log(`Last processed comment: ${auction.last_comment_id}`);
    console.log(`Last successful VK poll: ${auction.last_successful_poll || 'never'}`);
    console.log(`Consecutive failures: ${auction.consecutive_failures}`);
    console.log(`Next poll: ${auction.next_poll_at || '-'}\nLast error code: ${auction.last_error_code || '-'}`);
  }
  if (hasTable(db, 'reminder_packages')) {
    console.log('\nReminder packages:');
    console.table(db.prepare(`SELECT status, publisher, COUNT(*) AS count FROM reminder_packages GROUP BY status, publisher`).all());
  }
}

export function runStatusCommand(command) {
  if (!existsSync(config.sqlitePath)) {
    console.error(`SQLite database does not exist: ${config.sqlitePath}`);
    process.exitCode = 1;
    return;
  }
  const db = new Database(config.sqlitePath, { readonly: true, fileMustExist: true });
  try {
    if (command === 'api-usage') printApiUsage(db);
    else printAuctionStatus(db);
  } finally {
    db.close();
  }
}
