# VK Auction Bot

Node.js bot for VK auction automation. It polls auction posts, parses bid comments,
updates current lot summaries, closes finished lots, publishes VK reminder posts,
and sends a Happy Santa broadcast reminder.

## Runtime

- Node.js: tested with Node.js `v24.14.1`
- Database: SQLite via `better-sqlite3`
- Production process manager: existing systemd service `vk-auction-bot`

## Installation

```bash
npm ci
```

## Required Environment Variables

Create a local `.env` file on the target machine. Do not commit `.env`.

Required:

```env
VK_SERVICE_TOKEN=
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
SQLITE_BACKUP_DIR=
HS_API_BASE_URL=https://broadcast.vkforms.ru/api/v2
HS_TIMEOUT_MS=10000
POLL_INITIAL_MS=600000
POLL_INITIAL_WINDOW_MS=10800000
POLL_QUIET_MS=3600000
POLL_DAY_MS=1800000
POLL_ACTIVE_MS=600000
POLL_APPROACHING_MS=120000
POLL_CLOSING_MS=60000
POLL_DEADLINE_MS=15000
POLL_APPROACHING_WINDOW_MS=7200000
POLL_CLOSING_WINDOW_MS=1800000
POLL_DEADLINE_WINDOW_MS=300000
POLL_GRACE_MS=300000
POLL_GRACE_WINDOW_MS=1800000
AUCTION_DISCOVERY_START=18:01
AUCTION_DISCOVERY_END=20:11
AUCTION_DISCOVERY_MS=600000
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

## Production Service

Run only one bot instance at a time.

Production is managed by the existing systemd service `vk-auction-bot`. Its unit
file is managed on the VPS and is not stored in this repository. Verify the
unit's current `WorkingDirectory`, `ExecStart`, environment source and user on
the VPS before an approved deployment; do not replace it with PM2 based on this
README.

Recommended VPS layout:

```text
/opt/bots/vk-auction-bot/
  app/
  data/
```

Run the application with:

```text
WorkingDirectory=/opt/bots/vk-auction-bot/app
SQLITE_PATH=/opt/bots/vk-auction-bot/data/auction.db
```

Filesystem paths are resolved from configuration. `SQLITE_PATH` may be absolute
or relative to the application directory. `SQLITE_BACKUP_DIR` is optional; if it
is not set, migration backups are written to a `backups/` directory next to the
configured SQLite database file.

Useful checks:

```bash
sudo systemctl cat vk-auction-bot
sudo systemctl status vk-auction-bot
journalctl -u vk-auction-bot -n 100 --no-pager
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

Auction discovery runs at `18:01, 18:11, ... 20:11 Europe/Moscow` and stops for
the rest of the Moscow calendar day as soon as today's auction is found. Process
startup performs one recovery discovery regardless of the current time.

Bid polling uses the current effective end, including anti-sniper extensions:

- first 3 hours after publication: every 10 minutes;
- after that and before 08:00: every 60 minutes;
- 08:00-17:00: every 30 minutes;
- after 17:00 until T-2h: every 10 minutes;
- T-2h: every 2 minutes;
- T-30m: every minute;
- T-5m: every 15 seconds;
- after the effective deadline: reconciliation every 5 minutes for at most 30 minutes.

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

The bot creates a timestamped SQLite backup before startup schema migrations,
but only when a migration is actually required. By default backups are written
next to the configured SQLite database file, for example
`/opt/bots/vk-auction-bot/data/backups/` when `SQLITE_PATH` points to
`/opt/bots/vk-auction-bot/data/auction.db`.

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
