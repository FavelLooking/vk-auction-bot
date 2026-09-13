import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import axios from 'axios';

const onlyDryRun = process.argv.includes('--dry-run');
const testDir = mkdtempSync(join(tmpdir(), 'vk-reminder-publisher-'));
Object.assign(process.env, {
  SQLITE_PATH: join(testDir, 'auction.db'), SQLITE_BACKUP_DIR: join(testDir, 'backups'),
  VK_SERVICE_TOKEN: 'mock-service', VK_GROUP_TOKEN: 'mock-group', VK_USER_TOKEN: 'forbidden-user',
  VK_GROUP_ID: '57561517', AUTO_REPLY: 'false', AUCTION_REMINDERS_ENABLED: 'true',
  REBUILD_MODE: 'false', DRY_RUN: 'true', USE_LM_STUDIO: 'false',
  HS_API_TOKEN: 'mock-hs', HS_AUCTION_LIST_ID: '1', REMINDER_PUBLISHER: 'group-token'
});

const requests = [];
axios.defaults.adapter = async (request) => {
  assert.equal(onlyDryRun, false, 'DRY_RUN test must not call any API');
  assert.equal(request.url, 'wall.post', 'Unexpected API method in reminder test');
  requests.push({ ...request.params });
  return { status: 200, statusText: 'OK', headers: {}, config: request,
    data: { response: { post_id: 99000 + requests.length } } };
};
globalThis.fetch = async () => { throw new Error('Real network disabled in reminder tests'); };

const { config } = await import('../src/config.js');
const { logger } = await import('../src/logger.js');
const store = await import('../src/db.js');
const { db } = store;
const { runAuctionReminders, buildAuctionReminderPayload } = await import('../src/reminderService.js');
const { getReminderPublisher, GroupTokenReminderPublisher, PackageOnlyPublisher } = await import('../src/services/notifications/reminderPublisher.js');
const { createWallPost } = await import('../src/vk.js');
config.vkRequestSpacingMs = 0;
logger.info = () => {};
let passed = 0;

function fixture(postId, single = false, bids = true) {
  const post = { id: postId, date: Date.parse('2026-09-12T12:00:00+03:00') / 1000,
    text: single ? '#CP_Аукцион_Одиночный' : '#cp_аукцион',
    attachments: [{ type: 'doc' },
      { type: 'photo', photo: { owner_id: -57561517, id: 123 } },
      { type: 'photo', photo: { owner_id: -57561517, id: 456 } }] };
  const auction = store.getOrCreateAuction(config.vkGroupId, post.id, new Date(post.date * 1000).toISOString(), null);
  if (bids) {
    for (const lotNumber of [1, 2]) {
      const bid = store.saveBid({ auctionId: auction.id, commentId: postId * 10 + lotNumber,
        lotNumber, userId: 10, userName: 'Current Bidder', amount: lotNumber * 500, status: 'accepted' });
      store.updateLotState({ auctionId: auction.id, lotNumber, currentPrice: bid.amount,
        leaderUserId: 10, leaderName: 'Current Bidder', bidId: bid.id });
    }
  }
  return { post, auction };
}

async function runTwice(fixture, scheduleTime) {
  const now = new Date(`2026-09-13T${scheduleTime}:00+03:00`);
  await runAuctionReminders(scheduleTime, now, { auctionPosts: [fixture.post] });
  await runAuctionReminders(scheduleTime, now, { auctionPosts: [fixture.post] });
  return store.getReminderPackage(fixture.auction.id, scheduleTime);
}

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

try {
  if (!onlyDryRun) {
    await check('GROUP wall.post, first photo, unchanged payload, and one reminder per schedule', async () => {
      config.dryRun = false;
      assert.ok(getReminderPublisher() instanceof GroupTokenReminderPublisher);
      for (const single of [false, true]) {
        const value = fixture(single ? 91002 : 91001, single);
        const storedPhotos = [];
        for (const scheduleTime of ['08:00', '17:00']) {
          const before = requests.length;
          const saved = await runTwice(value, scheduleTime);
          assert.equal(requests.length, before + 1);
          const params = requests.at(-1);
          const rows = store.getCurrentSummary(value.auction.id).filter((row) => !single || row.lot_number === 1);
          const expected = buildAuctionReminderPayload({ post: value.post, summaryRows: rows,
            scheduleTime, postDate: value.auction.post_date });
          assert.equal(params.access_token, 'mock-group');
          assert.equal(params.owner_id, -57561517);
          assert.equal(params.from_group, 1);
          assert.equal(params.attachments, 'photo-57561517_123');
          assert.equal(params.message, expected.message);
          assert.ok(params.message.includes(`https://vk.com/wall-57561517_${value.post.id}`));
          assert.ok(params.message.includes('#CP_НапоминаниеАукциона'));
          assert.ok(params.message.includes('1 - 500'));
          assert.equal(params.message.includes('2 - 1000'), !single);
          assert.equal(Object.hasOwn(params, 'publish_date'), false);
          assert.equal(saved.status, 'published');
          assert.equal(saved.publisher, 'group-token');
          storedPhotos.push(JSON.parse(saved.payload_json).attachments[0]);
          assert.equal(store.getAuctionReminderRecord({ auctionId: value.auction.id, scheduleTime }).reminder_post_id,
            99000 + requests.length);
        }
        assert.deepEqual(storedPhotos, ['photo-57561517_123', 'photo-57561517_123']);
      }
      assert.equal(requests.length, 4);
      const rows = db.prepare('SELECT operation, method, token_type, success FROM vk_api_usage').all();
      assert.equal(rows.length, 4);
      for (const row of rows) assert.deepEqual(row, { operation: 'reminder', method: 'wall.post', token_type: 'group', success: 1 });
    });

    await check('persisted reminder prevents another publication after process restart', async () => {
      const post = fixture(91001, false, false).post;
      const script = `import assert from 'node:assert/strict'; import axios from 'axios';
        let attempts = 0;
        axios.defaults.adapter = async () => { attempts += 1; throw new Error('No network allowed'); };
        globalThis.fetch = async () => { throw new Error('No network allowed'); };
        const {runAuctionReminders} = await import('./src/reminderService.js');
        const {db} = await import('./src/db.js');
        try {
          for (const scheduleTime of ['08:00', '17:00']) {
            await runAuctionReminders(scheduleTime, new Date('2026-09-13T' + scheduleTime + ':00+03:00'),
              {auctionPosts: [${JSON.stringify(post)}]});
          }
          assert.equal(attempts, 0);
        } finally { db.close(); }`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, DRY_RUN: 'false' }, encoding: 'utf8', timeout: 20000
      });
      assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
    });
  }

  await check('DRY_RUN selects package-only and blocks wall.post at the VK wrapper', async () => {
    config.dryRun = true;
    config.reminderPublisher = 'group-token';
    assert.ok(getReminderPublisher() instanceof PackageOnlyPublisher);
    const value = fixture(92001);
    const before = requests.length;
    for (const time of ['08:00', '17:00']) {
      const saved = await runTwice(value, time);
      assert.equal(saved.status, 'pending');
      assert.equal(saved.reason, 'dry_run');
      assert.equal(saved.publisher, 'package-only');
      assert.deepEqual(JSON.parse(saved.payload_json).attachments, ['photo-57561517_123']);
      assert.equal(store.getAuctionReminderRecord({ auctionId: value.auction.id, scheduleTime: time }).reminder_post_id, null);
    }
    await assert.rejects(createWallPost({ groupId: 57561517, message: 'blocked' }), /disabled/);
    assert.equal(requests.length, before);
  });

  await check('explicit package-only/disabled modes do not call VK', async () => {
    config.dryRun = false;
    const before = requests.length;
    for (const [index, mode] of ['package-only', 'disabled'].entries()) {
      config.reminderPublisher = mode;
      assert.ok(getReminderPublisher() instanceof PackageOnlyPublisher);
      const value = fixture(93001 + index);
      const saved = await runTwice(value, '08:00');
      assert.equal(saved.status, 'pending');
      await assert.rejects(createWallPost({ groupId: 57561517, message: 'blocked' }), /disabled/);
    }
    assert.equal(requests.length, before);
  });

  await check('zero bids create no reminder, and pending packages are not replayed on mode switch', async () => {
    config.reminderPublisher = 'group-token';
    config.dryRun = false;
    const before = requests.length;
    const empty = fixture(94001, false, false);
    assert.equal(await runTwice(empty, '08:00'), undefined);
    const pending = fixture(93001, false, false);
    await runTwice(pending, '08:00');
    assert.equal(store.getReminderPackage(pending.auction.id, '08:00').status, 'pending');
    assert.equal(requests.length, before);
  });

  await check('no source photo keeps the existing text-only fallback without uploads', async () => {
    config.reminderPublisher = 'group-token';
    config.dryRun = onlyDryRun;
    const value = fixture(95001);
    value.post.attachments = [{ type: 'doc' }];
    const before = requests.length;
    const saved = await runTwice(value, '17:00');
    const payload = JSON.parse(saved.payload_json);
    assert.deepEqual(payload.attachments, []);
    assert.ok(payload.message.includes('https://vk.com/wall-57561517_95001'));
    assert.ok(payload.message.includes('#CP_НапоминаниеАукциона'));
    assert.equal(requests.length, before + (onlyDryRun ? 0 : 1));
    if (!onlyDryRun) assert.equal(Object.hasOwn(requests.at(-1), 'attachments'), false);
  });

  await check('group-token configuration passes without a USER token', async () => {
    const child = spawnSync(process.execPath, ['src/index.js', '--check-config'], {
      env: { ...process.env, VK_USER_TOKEN: '', DRY_RUN: 'false' }, encoding: 'utf8', timeout: 20000
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(child.stdout.includes('Configuration OK'));
  });

  console.log(`Reminder publisher tests passed: ${passed}. Mode: ${onlyDryRun ? 'DRY_RUN/package-only' : 'mock VK + DRY_RUN'}.`);
  console.log(`Real network requests: 0. Mock wall.post requests: ${requests.length}.`);
} finally {
  db.close();
  rmSync(testDir, { recursive: true, force: true });
}
