# VK Auction Bot

Node.js bot for VK auction automation. It polls auction posts, parses bid comments,
updates current lot summaries, closes finished lots, publishes VK reminder posts,
and sends a Happy Santa broadcast reminder.

## Runtime

- Node.js: tested with Node.js `v24.14.1`
- Database: SQLite via `better-sqlite3`
- Process manager for production: PM2

## Installation

```bash
npm ci
```

## Required Environment Variables

Create a local `.env` file on the target machine. Do not commit `.env`.

Required:

```env
VK_USER_TOKEN=
VK_GROUP_TOKEN=
VK_GROUP_ID=
SQLITE_PATH=
AUTO_REPLY=
AUCTION_REMINDERS_ENABLED=
REBUILD_MODE=
HS_API_TOKEN=
HS_AUCTION_LIST_ID=
```

Recommended production settings:

```env
TZ=Europe/Moscow
HS_API_BASE_URL=https://broadcast.vkforms.ru/api/v2
HS_TIMEOUT_MS=10000
POLL_INTERVAL_MS=15000
POLL_FAST_INTERVAL_MS=15000
POLL_NORMAL_INTERVAL_MS=60000
POLL_NIGHT_INTERVAL_MS=300000
POLL_FAST_AFTER_POST_MS=7200000
POLL_CLOSING_SOON_MS=1800000
MIN_BID_STEP=50
ALLOW_EQUAL_BID=false
AUCTION_POST_SEARCH_LIMIT=15
AUCTION_TAG=#cp_аукцион
SINGLE_AUCTION_TAG=#CP_Аукцион_Одиночный
ONLY_PINNED=false
SKIP_OLD_ON_FIRST_SEEN=true
REPLY_DELAY_MS=700
DRY_RUN=false
```

## Commands

Production start:

```bash
npm run start
```

Development start:

```bash
npm run dev
```

Admin CLI:

```bash
npm run admin
```

Manual Happy Santa send:

```bash
npm run hs:test
npm run hs:test -- --now=2026-07-13T19:35:00
npm run hs:test -- --force
```

`--force` bypasses Happy Santa duplicate protection and should be used carefully.

## Production With PM2

Run only one bot instance at a time.

```bash
pm2 start npm --name vk-auction-bot -- run start
pm2 save
pm2 startup
```

Useful checks:

```bash
pm2 status
pm2 logs vk-auction-bot
pm2 restart vk-auction-bot
```

## Scheduled Automation

The scheduler runs inside the long-lived Node.js process:

- auction polling and bid parsing;
- summary refresh;
- winner detection and automatic lot closing;
- VK reminder post at `08:00 Europe/Moscow`;
- VK reminder post at `17:00 Europe/Moscow`;
- Happy Santa broadcast at `19:35 Europe/Moscow`.

No cron or Windows Task Scheduler is required for these jobs as long as the Node.js
process is alive.

## Happy Santa Integration

Happy Santa broadcasts use `HS_API_TOKEN` and `HS_AUCTION_LIST_ID`.

The request body uses the Happy Santa message object format:

```json
{
  "list_ids": [391079],
  "run_now": 1,
  "message": {
    "message": "Reminder text",
    "attachment": "photo-1_1,photo-1_2"
  }
}
```

Duplicate protection is stored in SQLite using keys like:

```text
happy_santa_25m:<ending_post_id>
```

## SQLite Deployment Notes

SQLite runs in WAL mode. Before moving the bot to a VPS, stop the local bot first.

Safe migration procedure:

1. Stop the local bot.
2. Copy these files together:

```text
auction.db
auction.db-wal
auction.db-shm
```

3. Copy `.env` to the VPS separately.
4. Start the VPS bot.
5. Keep the local bot stopped.

The bot creates a timestamped SQLite backup in `backups/` before startup schema
migrations, but only when a migration is actually required.

## Deployment Notes

- Do not run the local bot and VPS bot at the same time.
- Do not commit `.env`, SQLite files, logs, backups, or `node_modules`.
- Run `npm ci` on the VPS instead of copying `node_modules`.
- Confirm startup diagnostics show the correct database path, VK group, scheduler
  status, Happy Santa status, timezone, and next scheduled runs.

## Sanity Checks

```bash
node --check src/index.js
node --check src/scheduler.js
node --check src/reminderService.js
node --check src/services/happySanta/client.js
npm run test:single-auction
```
