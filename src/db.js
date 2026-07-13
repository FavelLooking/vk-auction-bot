import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

export const db = new Database(config.sqlitePath);

db.pragma('journal_mode = WAL');

const EXPECTED_TABLES = [
  'auctions',
  'auction_summaries',
  'processed_comments',
  'bids',
  'lot_state',
  'bot_replies',
  'auction_reminders',
  'vk_user_cache',
  'happy_santa_broadcasts'
];

function getUserTableNames() {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function getTableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function getBackupTimestamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${map.year}-${map.month}-${map.day}-${map.hour}-${map.minute}`;
}

function getBackupPath() {
  const ext = extname(config.sqlitePath);
  const base = basename(config.sqlitePath, ext) || 'auction';
  const backupDir = join(process.cwd(), 'backups');

  mkdirSync(backupDir, { recursive: true });

  return join(backupDir, `${base}-${getBackupTimestamp()}.db`);
}

function createSchemaMigrationBackup(reason) {
  if (!existsSync(config.sqlitePath)) {
    return null;
  }

  const backupPath = getBackupPath();
  const quotedBackupPath = db.prepare('SELECT quote(?) AS value').get(backupPath).value;

  logger.warn(`SQLite schema migration required: ${reason}`);
  logger.warn(`Creating SQLite backup before migration: ${backupPath}`);
  db.exec(`VACUUM INTO ${quotedBackupPath}`);
  logger.info(`SQLite backup created: ${backupPath}`);

  return backupPath;
}

function getSchemaMigrationReason() {
  const tableNames = getUserTableNames();

  if (!tableNames.length) {
    return null;
  }

  const missingTables = EXPECTED_TABLES.filter((tableName) => !tableNames.includes(tableName));

  if (missingTables.length) {
    return `missing table(s): ${missingTables.join(', ')}`;
  }

  const reminderColumns = getTableColumns('auction_reminders');
  const hasLegacyReminderColumns =
    reminderColumns.includes('schedule_date') ||
    reminderColumns.includes('reminder_text') ||
    reminderColumns.includes('status') ||
    reminderColumns.includes('updated_at') ||
    !reminderColumns.includes('deleted_at');

  if (hasLegacyReminderColumns) {
    return 'auction_reminders table requires migration';
  }

  return null;
}

const schemaMigrationReason = getSchemaMigrationReason();

if (schemaMigrationReason) {
  createSchemaMigrationBackup(schemaMigrationReason);
}

db.exec(`
CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  post_date TEXT,
  armed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id, post_id)
);

  CREATE TABLE IF NOT EXISTS auction_summaries (
    auction_id INTEGER PRIMARY KEY,
    summary_comment_id INTEGER,
    summary_text TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (auction_id) REFERENCES auctions(id)
  );

  CREATE TABLE IF NOT EXISTS processed_comments (
    comment_id INTEGER PRIMARY KEY,
    parent_id INTEGER,
    from_id INTEGER,
    text TEXT,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    parse_status TEXT NOT NULL,
    raw_result_json TEXT
  );

  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL,
    comment_id INTEGER NOT NULL,
    lot_number INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (auction_id) REFERENCES auctions(id)
  );

CREATE TABLE IF NOT EXISTS lot_state (
  auction_id INTEGER NOT NULL,
  lot_number INTEGER NOT NULL,
  current_price INTEGER NOT NULL,
  leader_user_id INTEGER NOT NULL,
  leader_name TEXT,
  bid_id INTEGER NOT NULL,
  ends_at TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0,
  winner_notified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (auction_id, lot_number),
  FOREIGN KEY (auction_id) REFERENCES auctions(id),
  FOREIGN KEY (bid_id) REFERENCES bids(id)
);

  CREATE TABLE IF NOT EXISTS bot_replies (
    comment_id INTEGER PRIMARY KEY,
    reply_comment_id INTEGER,
    reply_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auction_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER NOT NULL,
    reminder_post_id INTEGER,
    schedule_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    UNIQUE(auction_id, schedule_time),
    FOREIGN KEY (auction_id) REFERENCES auctions(id)
  );

  CREATE TABLE IF NOT EXISTS vk_user_cache (
    user_id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    domain TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS happy_santa_broadcasts (
    reminder_key TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT,
    response_json TEXT
  );
`);

function migrateAuctionRemindersTable() {
  const columns = getTableColumns('auction_reminders');
  const hasLegacyReminderColumns =
    columns.includes('schedule_date') ||
    columns.includes('reminder_text') ||
    columns.includes('status') ||
    columns.includes('updated_at') ||
    !columns.includes('deleted_at');

  if (!hasLegacyReminderColumns) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS auction_reminders_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id INTEGER NOT NULL,
      reminder_post_id INTEGER,
      schedule_time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      UNIQUE(auction_id, schedule_time),
      FOREIGN KEY (auction_id) REFERENCES auctions(id)
    );

    INSERT OR IGNORE INTO auction_reminders_next (
      auction_id,
      reminder_post_id,
      schedule_time,
      created_at,
      deleted_at
    )
    SELECT
      auction_id,
      reminder_post_id,
      schedule_time,
      MIN(created_at),
      CASE
        WHEN status = 'deleted' THEN MAX(updated_at)
        ELSE NULL
      END
    FROM auction_reminders
    GROUP BY auction_id, schedule_time;

    DROP TABLE auction_reminders;
    ALTER TABLE auction_reminders_next RENAME TO auction_reminders;
  `);
}

migrateAuctionRemindersTable();

export function getAuctionSummaryRecord(auctionId) {
  return db
    .prepare(`SELECT * FROM auction_summaries WHERE auction_id = ?`)
    .get(auctionId);
}

export function saveAuctionSummaryRecord({
  auctionId,
  summaryCommentId,
  summaryText
}) {
  db.prepare(`
    INSERT INTO auction_summaries (
      auction_id, summary_comment_id, summary_text, updated_at
    ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(auction_id)
    DO UPDATE SET
      summary_comment_id = excluded.summary_comment_id,
      summary_text = excluded.summary_text,
      updated_at = CURRENT_TIMESTAMP
  `).run(auctionId, summaryCommentId ?? null, summaryText);
}

export function clearAuctionSummaryRecord(auctionId) {
  db.prepare(`DELETE FROM auction_summaries WHERE auction_id = ?`).run(auctionId);
}

export function getOrCreateAuction(groupId, postId, postDate = null, armedAt = null) {
  const existing = db
    .prepare(`SELECT * FROM auctions WHERE group_id = ? AND post_id = ?`)
    .get(groupId, postId);

  if (existing) {
    const nextPostDate = existing.post_date || postDate || null;
    const nextArmedAt = existing.armed_at || armedAt || null;

    if (nextPostDate !== existing.post_date || nextArmedAt !== existing.armed_at) {
      db.prepare(`
        UPDATE auctions
        SET post_date = ?, armed_at = ?
        WHERE id = ?
      `).run(nextPostDate, nextArmedAt, existing.id);

      return db.prepare(`SELECT * FROM auctions WHERE id = ?`).get(existing.id);
    }

    return existing;
  }

  const insert = db.prepare(`
    INSERT INTO auctions (group_id, post_id, post_date, armed_at)
    VALUES (?, ?, ?, ?)
  `).run(groupId, postId, postDate, armedAt);

  return db.prepare(`SELECT * FROM auctions WHERE id = ?`).get(insert.lastInsertRowid);
}

export function isCommentProcessed(commentId) {
  const row = db
    .prepare(`SELECT comment_id FROM processed_comments WHERE comment_id = ?`)
    .get(commentId);

  return Boolean(row);
}

export function saveProcessedComment({
  commentId,
  parentId,
  fromId,
  text,
  parseStatus,
  rawResultJson
}) {
  db.prepare(`
    INSERT OR IGNORE INTO processed_comments (
      comment_id, parent_id, from_id, text, parse_status, raw_result_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    commentId,
    parentId ?? null,
    fromId,
    text,
    parseStatus,
    rawResultJson ?? null
  );
}

export function getLotState(auctionId, lotNumber) {
  return db
    .prepare(`SELECT * FROM lot_state WHERE auction_id = ? AND lot_number = ?`)
    .get(auctionId, lotNumber);
}

export function saveBid({
  auctionId,
  commentId,
  lotNumber,
  userId,
  userName,
  amount,
  status,
  reason
}) {
  const result = db.prepare(`
    INSERT INTO bids (
      auction_id, comment_id, lot_number, user_id, user_name, amount, status, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    auctionId,
    commentId,
    lotNumber,
    userId,
    userName ?? null,
    amount,
    status,
    reason ?? null
  );

  return db.prepare(`SELECT * FROM bids WHERE id = ?`).get(result.lastInsertRowid);
}

export function getBidById(bidId) {
  return db.prepare(`SELECT * FROM bids WHERE id = ?`).get(bidId);
}

export function updateLotState({
  auctionId,
  lotNumber,
  currentPrice,
  leaderUserId,
  leaderName,
  bidId,
  endsAt = null,
  isClosed = 0
}) {
  db.prepare(`
    INSERT INTO lot_state (
      auction_id,
      lot_number,
      current_price,
      leader_user_id,
      leader_name,
      bid_id,
      ends_at,
      is_closed,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(auction_id, lot_number)
    DO UPDATE SET
      current_price = excluded.current_price,
      leader_user_id = excluded.leader_user_id,
      leader_name = excluded.leader_name,
      bid_id = excluded.bid_id,
      ends_at = excluded.ends_at,
      is_closed = excluded.is_closed,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    auctionId,
    lotNumber,
    currentPrice,
    leaderUserId,
    leaderName ?? null,
    bidId,
    endsAt,
    isClosed
  );
}

export function closeLot({ auctionId, lotNumber }) {
  db.prepare(`
    UPDATE lot_state
    SET is_closed = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE auction_id = ? AND lot_number = ?
  `).run(auctionId, lotNumber);
}

export function reopenLot({ auctionId, lotNumber, endsAt = null }) {
  db.prepare(`
    UPDATE lot_state
    SET is_closed = 0,
        ends_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE auction_id = ? AND lot_number = ?
  `).run(endsAt, auctionId, lotNumber);
}

export function markWinnerNotified({ auctionId, lotNumber }) {
  db.prepare(`
    UPDATE lot_state
    SET winner_notified = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE auction_id = ? AND lot_number = ?
  `).run(auctionId, lotNumber);
}

export function getExpiredOpenLots(nowIso) {
  return db.prepare(`
    SELECT
      ls.auction_id,
      ls.lot_number,
      ls.current_price,
      ls.leader_user_id,
      ls.leader_name,
      ls.bid_id,
      ls.ends_at,
      ls.is_closed,
      ls.winner_notified,
      a.post_id,
      a.post_date,
      a.armed_at
    FROM lot_state ls
    JOIN auctions a ON a.id = ls.auction_id
    WHERE ls.is_closed = 0
      AND a.armed_at IS NOT NULL
    ORDER BY a.post_id ASC, ls.lot_number ASC
  `).all().filter((row) => {
    const now = new Date(nowIso);
    let endTime = null;

    if (row.ends_at) {
      endTime = new Date(row.ends_at);
    } else if (row.post_date) {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });

      const parts = formatter.formatToParts(new Date(row.post_date));
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

      endTime = new Date(`${map.year}-${map.month}-${map.day}T20:00:00+03:00`);
      endTime.setUTCDate(endTime.getUTCDate() + 1);
    }

    return endTime && now >= endTime;
  });
}

export function saveBotReply({ commentId, replyCommentId, replyText }) {
  db.prepare(`
    INSERT OR REPLACE INTO bot_replies (
      comment_id, reply_comment_id, reply_text
    ) VALUES (?, ?, ?)
  `).run(commentId, replyCommentId ?? null, replyText);
}

export function getCurrentSummary(auctionId) {
  return db.prepare(`
    SELECT
      lot_number,
      current_price,
      leader_name,
      leader_user_id,
      ends_at,
      is_closed
    FROM lot_state
    WHERE auction_id = ?
    ORDER BY lot_number ASC
  `).all(auctionId);
}

export function getRecentAuctionsForAdmin(limit = 20) {
  return db.prepare(`
    SELECT
      a.id,
      a.group_id,
      a.post_id,
      a.post_date,
      a.armed_at,
      a.status,
      a.created_at,
      COUNT(ls.lot_number) AS lot_count,
      SUM(CASE WHEN ls.is_closed = 0 THEN 1 ELSE 0 END) AS open_lot_count
    FROM auctions a
    LEFT JOIN lot_state ls ON ls.auction_id = a.id
    GROUP BY a.id
    ORDER BY
      CASE WHEN a.status = 'active' THEN 0 ELSE 1 END,
      COALESCE(a.armed_at, a.post_date, a.created_at) DESC
    LIMIT ?
  `).all(limit);
}

export function getAuctionById(auctionId) {
  return db.prepare(`SELECT * FROM auctions WHERE id = ?`).get(auctionId);
}

export function getAuctionByGroupPost({ groupId, postId }) {
  return db
    .prepare(`SELECT * FROM auctions WHERE group_id = ? AND post_id = ?`)
    .get(groupId, postId);
}

export function getLotsForAdmin(auctionId) {
  return db.prepare(`
    SELECT
      lot_number,
      current_price,
      leader_user_id,
      leader_name,
      bid_id,
      ends_at,
      is_closed,
      winner_notified,
      updated_at
    FROM lot_state
    WHERE auction_id = ?
    ORDER BY lot_number ASC
  `).all(auctionId);
}

export function getBidHistoryForLot({ auctionId, lotNumber }) {
  return db.prepare(`
    SELECT
      id,
      comment_id,
      user_id,
      user_name,
      amount,
      status,
      reason,
      created_at
    FROM bids
    WHERE auction_id = ?
      AND lot_number = ?
    ORDER BY id DESC
  `).all(auctionId, lotNumber);
}

export function voidBidAndRecalculateLot({ bidId }) {
  return db.transaction(() => {
    const bid = db.prepare(`SELECT * FROM bids WHERE id = ?`).get(bidId);
    if (!bid) {
      throw new Error(`Bid ${bidId} was not found`);
    }

    const previousLotState = getLotState(bid.auction_id, bid.lot_number);

    db.prepare(`
      UPDATE bids
      SET status = 'voided'
      WHERE id = ?
    `).run(bidId);

    const nextLeader = db.prepare(`
      SELECT *
      FROM bids
      WHERE auction_id = ?
        AND lot_number = ?
        AND status = 'accepted'
      ORDER BY id DESC
      LIMIT 1
    `).get(bid.auction_id, bid.lot_number);

    if (!nextLeader) {
      db.prepare(`
        DELETE FROM lot_state
        WHERE auction_id = ?
          AND lot_number = ?
      `).run(bid.auction_id, bid.lot_number);

      return {
        bid,
        previousLotState,
        nextLotState: null
      };
    }

    updateLotState({
      auctionId: bid.auction_id,
      lotNumber: bid.lot_number,
      currentPrice: nextLeader.amount,
      leaderUserId: nextLeader.user_id,
      leaderName: nextLeader.user_name,
      bidId: nextLeader.id,
      endsAt: previousLotState?.ends_at ?? null,
      isClosed: previousLotState?.is_closed ?? 0
    });

    if (previousLotState?.winner_notified) {
      db.prepare(`
        UPDATE lot_state
        SET winner_notified = ?
        WHERE auction_id = ?
          AND lot_number = ?
      `).run(previousLotState.winner_notified, bid.auction_id, bid.lot_number);
    }

    return {
      bid,
      previousLotState,
      nextLotState: getLotState(bid.auction_id, bid.lot_number)
    };
  })();
}

export function getAuctionReminderRecord({
  auctionId,
  scheduleTime
}) {
  return db.prepare(`
    SELECT *
    FROM auction_reminders
    WHERE auction_id = ?
      AND schedule_time = ?
  `).get(auctionId, scheduleTime);
}

export function saveAuctionReminderRecord({
  auctionId,
  scheduleTime,
  reminderPostId
}) {
  db.prepare(`
    INSERT INTO auction_reminders (
      auction_id,
      schedule_time,
      reminder_post_id
    ) VALUES (?, ?, ?)
    ON CONFLICT(auction_id, schedule_time)
    DO UPDATE SET
      reminder_post_id = COALESCE(auction_reminders.reminder_post_id, excluded.reminder_post_id)
  `).run(
    auctionId,
    scheduleTime,
    reminderPostId ?? null
  );
}

export function getActiveAuctionReminderRecords() {
  return db.prepare(`
    SELECT
      ar.*,
      a.group_id,
      a.post_id,
      a.post_date
    FROM auction_reminders ar
    JOIN auctions a ON a.id = ar.auction_id
    WHERE ar.deleted_at IS NULL
    ORDER BY ar.created_at ASC
  `).all();
}

export function markAuctionReminderDeleted(reminderId) {
  db.prepare(`
    UPDATE auction_reminders
    SET deleted_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reminderId);
}

export function getHappySantaBroadcastRecord(reminderKey) {
  return db.prepare(`
    SELECT *
    FROM happy_santa_broadcasts
    WHERE reminder_key = ?
  `).get(reminderKey);
}

export function claimHappySantaBroadcast(reminderKey) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO happy_santa_broadcasts (
      reminder_key,
      status
    ) VALUES (?, 'sending')
  `).run(reminderKey);

  return result.changes === 1;
}

export function markHappySantaBroadcastSent({ reminderKey, responseJson }) {
  db.prepare(`
    INSERT INTO happy_santa_broadcasts (
      reminder_key,
      status,
      sent_at,
      response_json
    ) VALUES (?, 'sent', CURRENT_TIMESTAMP, ?)
    ON CONFLICT(reminder_key)
    DO UPDATE SET
      status = 'sent',
      sent_at = CURRENT_TIMESTAMP,
      response_json = excluded.response_json
  `).run(reminderKey, responseJson ?? null);
}

export function clearHappySantaBroadcastClaim(reminderKey) {
  db.prepare(`
    DELETE FROM happy_santa_broadcasts
    WHERE reminder_key = ?
      AND status = 'sending'
  `).run(reminderKey);
}

export function getCachedVkUsers(userIds = []) {
  const ids = [...new Set(userIds.filter((id) => id > 0))];
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(',');

  return db.prepare(`
    SELECT
      user_id AS id,
      first_name,
      last_name,
      domain
    FROM vk_user_cache
    WHERE user_id IN (${placeholders})
  `).all(...ids);
}

export function saveCachedVkUsers(users = []) {
  if (!users.length) return;

  const save = db.prepare(`
    INSERT INTO vk_user_cache (
      user_id,
      first_name,
      last_name,
      domain,
      updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id)
    DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      domain = excluded.domain,
      updated_at = CURRENT_TIMESTAMP
  `);

  const tx = db.transaction((rows) => {
    for (const user of rows) {
      save.run(
        user.id,
        user.first_name ?? null,
        user.last_name ?? null,
        user.domain ?? null
      );
    }
  });

  tx(users);
}

