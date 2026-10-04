import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import axios from 'axios';

const testDir = mkdtempSync(join(tmpdir(), 'vk-auction-migration-'));
Object.assign(process.env, {
  SQLITE_PATH: join(testDir, 'auction.db'), SQLITE_BACKUP_DIR: join(testDir, 'backups'),
  VK_SERVICE_TOKEN: 'mock-service', VK_GROUP_TOKEN: 'mock-group', VK_USER_TOKEN: '',
  VK_GROUP_ID: '57561517', AUTO_REPLY: 'false', AUCTION_REMINDERS_ENABLED: 'true',
  REBUILD_MODE: 'false', DRY_RUN: 'true', USE_LM_STUDIO: 'false',
  HS_API_TOKEN: 'mock-hs', HS_AUCTION_LIST_ID: '1', REMINDER_PUBLISHER: 'package-only'
});

const requests = [];
let respond = async (method) => { throw new Error(`Unexpected mock VK request: ${method}`); };
axios.defaults.adapter = async (request) => {
  requests.push({ method: request.url, params: request.params, timeout: request.timeout });
  const data = await respond(request.url, request.params);
  return { data, status: 200, statusText: 'OK', headers: {}, config: request };
};

const store = await import('../src/db.js');
const { db } = store;
const { config } = await import('../src/config.js');
const { logger } = await import('../src/logger.js');
const vk = await import('../src/vk.js');
const { collectNewComments, getPollingPlan, pollAuction } = await import('../src/auctionPolling.js');
const { processAuctionComments } = await import('../src/auctionService.js');
const { runAuctionReminders, cleanupFinishedAuctionReminders } = await import('../src/reminderService.js');
const { getReminderSchedule, tick, startScheduler } = await import('../src/scheduler.js');
config.vkRequestSpacingMs = 0;
config.replyDelayMs = 0;
logger.info = () => {};
logger.warn = () => {};

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}
function post(id, single = false) {
  return { id, date: Date.parse('2026-09-12T10:00:00+03:00') / 1000,
    text: single ? '#CP_Аукцион_Одиночный' : '#cp_аукцион' };
}
function seedAuction(id, single = false) {
  const value = post(id, single);
  const auction = store.getOrCreateAuction(57561517, id,
    new Date(value.date * 1000).toISOString(), '2026-09-12T07:00:00.000Z');
  store.registerPollingPost(value);
  return { value, auction };
}
function seedLot(auctionId, lotNumber = 1, amount = 100) {
  const bid = store.saveBid({ auctionId, commentId: auctionId * 10000 + lotNumber, lotNumber,
    userId: 10, userName: 'Cached Bidder', amount, status: 'accepted' });
  store.updateLotState({ auctionId, lotNumber, currentPrice: amount, leaderUserId: 10,
    leaderName: 'Cached Bidder', bidId: bid.id });
  return bid;
}
function commentsPage(items) {
  return async ({ startCommentId }) => ({ items: items
    .filter((item) => startCommentId === undefined || item.id <= startCommentId)
    .sort((a, b) => b.id - a.id).slice(0, 100) });
}
function runChild(script, env = {}) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  return child.stdout;
}

try {
  await check('service reads, group replies, direct reply target, and usage records', async () => {
    respond = async (method) => ({ response: method === 'wall.createComment' ? { comment_id: 123 }
      : method === 'users.get' ? [{ id: 10, first_name: 'Cached', last_name: 'Bidder' }]
      : method === 'wall.deleteComment' ? 1 : { items: [] } });
    await vk.getWallPosts({ groupId: 57561517 });
    await vk.getWallComments({ groupId: 57561517, postId: 1 });
    await vk.getUserInfo([10]);
    await vk.createComment({ groupId: 57561517, postId: 1, message: 'mock reply', replyToCommentId: 42 });
    await vk.deleteComment({ groupId: 57561517, commentId: 123 });
    for (const request of requests.slice(0, 3)) assert.equal(request.params.access_token, 'mock-service');
    assert.equal(requests[3].params.access_token, 'mock-group');
    assert.equal(requests[3].params.reply_to_comment, 42);
    assert.equal(requests[3].params.from_group, 57561517);
    assert.equal(requests[4].params.access_token, 'mock-group');
    assert.ok(requests.every((request) => request.timeout === config.vkTimeoutMs));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vk_api_usage WHERE success = 1').get().n, 5);
  });

  await check('bounded backoff, restart persistence, method isolation, reset, redacted errors', async () => {
    let clock = 1000000;
    let calls = 0;
    let fail = true;
    const states = new Map();
    const logs = [];
    const options = {
      now: () => clock, sleep: async () => {},
      readState: (key) => states.get(key), writeState: (key, value) => states.set(key, value),
      beginUsage: () => 1, finishUsage: () => {},
      log: { warn: (message) => logs.push(message), info: (message) => logs.push(message) },
      transport: { get: async (method) => {
        calls += 1;
        return { data: fail && method === 'users.get'
          ? { error: { error_code: 9, request_params: [{ value: 'SECRET_MUST_NOT_APPEAR' }] } }
          : { response: [] } };
      } }
    };
    let call = vk.createVkCaller(options);
    const read = { tokenType: 'service', operation: 'test' };
    for (const delay of [15000, 30000, 60000, 120000, 240000, 300000, 300000]) {
      await assert.rejects(call('users.get', {}, read), (error) => {
        assert.equal(error.retryAt, clock + delay);
        assert.ok(!error.message.includes('SECRET'));
        return true;
      });
      const before = calls;
      call = vk.createVkCaller(options);
      await assert.rejects(call('users.get', {}, read));
      assert.equal(calls, before);
      await call('wall.getComments', {}, read);
      clock += delay;
    }
    fail = false;
    await call('users.get', {}, read);
    assert.deepEqual(states.get('vk:service:users.get'), { failures: 0, until: 0 });
    assert.ok(logs.some((line) => line.includes('Backoff reset')));
    assert.ok(logs.every((line) => !line.includes('SECRET')));
  });

  await check('timeouts, reset/abort, temporary VK errors and invalid responses are recoverable', async () => {
    for (const outcome of [
      { error: { error_code: 1 } }, { error: { error_code: 6 } }, { error: { error_code: 10 } },
      { error: { error_code: 29 } }, {}, null, 'not-json',
      Object.assign(new Error('sensitive transport detail'), { code: 'ECONNRESET' }),
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
    ]) {
      const call = vk.createVkCaller({
        transport: { get: async () => { if (outcome instanceof Error) throw outcome; return { data: outcome }; } },
        readState: () => null, writeState: () => {}, beginUsage: () => 1, finishUsage: () => {},
        log: { warn() {}, info() {} }
      });
      await assert.rejects(call('wall.getComments', {}, { tokenType: 'service', operation: 'test' }),
        (error) => error.temporary && !error.message.includes('sensitive'));
    }
  });

  await check('235 intermediate comments, overlapping pages, deleted old cursor, concurrent new comment', async () => {
    const items = Array.from({ length: 335 }, (_, index) => ({ id: index + 1, from_id: 10,
      date: 1000 + index, text: `1-${index + 100}` })).filter((item) => item.id !== 100);
    let pages = 0;
    const result = await collectNewComments({ groupId: 1, postId: 1, lastCommentId: 100 }, async (params) => {
      const page = await commentsPage(items)(params);
      if (++pages === 1) items.push({ id: 336, from_id: 10, date: 1336, text: '1-500' });
      return page;
    });
    assert.deepEqual(result.comments.map((item) => item.id), Array.from({ length: 235 }, (_, i) => i + 101));
    assert.equal(result.lastCommentId, 335);
    const next = await collectNewComments({ groupId: 1, postId: 1, lastCommentId: result.lastCommentId }, commentsPage(items));
    assert.deepEqual(next.comments.map((item) => item.id), [336]);
    assert.equal(pages, 3);
    let failPage = 0;
    await assert.rejects(collectNewComments({ groupId: 1, postId: 1 }, async (params) => {
      if (++failPage === 2) throw new vk.VkApiError('deleted page anchor', { code: 100 });
      return commentsPage(items)(params);
    }));
    const deleted = await collectNewComments({ groupId: 1, postId: 1 }, commentsPage([{ id: 1, deleted: true }]));
    assert.equal(deleted.comments[0].text, '');
  });

  await check('poll windows follow actual end and per-lot extension deadlines', async () => {
    const input = { postDate: '2026-09-12T07:00:00.000Z' };
    for (const [time, interval] of [
      ['00:00', 3600000], ['08:00', 1800000], ['17:59', 600000], ['18:00', 120000],
      ['19:30', 60000], ['19:55', 15000], ['20:00', 300000]
    ]) {
      assert.equal(getPollingPlan(input, new Date(`2026-09-13T${time}:00+03:00`)).intervalMs, interval);
    }
    const extension = { ...input, summaryRows: [
      { is_closed: 0, ends_at: '2026-09-13T20:18:00+03:00' },
      { is_closed: 0, ends_at: '2026-09-13T20:45:00+03:00' }
    ] };
    assert.equal(getPollingPlan(extension, new Date('2026-09-13T20:14:00+03:00')).intervalMs, 15000);
    assert.notEqual(getPollingPlan(extension, new Date('2026-09-13T23:00:00+03:00')).status, 'stopped');
    const grace = { ...input, summaryRows: [{ is_closed: 1, ends_at: '2026-09-13T20:18:00+03:00' }],
      lastSuccessfulPoll: '2026-09-13T20:48:00+03:00' };
    assert.equal(getPollingPlan(grace, new Date('2026-09-13T20:48:00+03:00')).status, 'stopped');
  });

  await check('crash after committed bids before cursor, restart and no bid replay', async () => {
    const { value, auction } = seedAuction(8001);
    store.saveCachedVkUsers([{ id: 10, first_name: 'Cached', last_name: 'Bidder' }]);
    const items = [5001, 5002, 5003].map((id, i) => ({ id, from_id: 10,
      date: Date.parse('2026-09-13T12:00:00+03:00') / 1000 + i, text: `1-${100 + i * 50}` }));
    const now = new Date('2026-09-13T12:01:00+03:00');
    const before = requests.length;
    assert.equal(await pollAuction(value, { now, readComments: commentsPage(items),
      processComments: async (args) => { await processAuctionComments(args); throw new Error('simulated crash before cursor'); }
    }), false);
    assert.equal(store.getAuctionPollState(auction.id).last_comment_id, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bids WHERE auction_id = ?').get(auction.id).n, 3);
    assert.equal(db.prepare('SELECT comment_at FROM bids WHERE auction_id = ? ORDER BY id LIMIT 1').get(auction.id).comment_at,
      '2026-09-13T09:00:00.000Z');
    assert.equal(await pollAuction(value, { now, readComments: commentsPage(items) }), true);
    assert.equal(store.getAuctionPollState(auction.id).last_comment_id, 5003);
    assert.equal(store.getLotState(auction.id, 1).current_price, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bids WHERE auction_id = ?').get(auction.id).n, 3);
    assert.equal(requests.length, before, 'cached users and no new comments must not cause helper API calls');
    const output = runChild(`const {db} = await import('./src/db.js');
      console.log(JSON.stringify(db.prepare('SELECT last_comment_id, consecutive_failures FROM auction_poll_state WHERE auction_id = ?').get(${auction.id})));
      db.close();`);
    assert.ok(output.includes('"last_comment_id":5003'));
    assert.ok(output.includes('"consecutive_failures":0'));
  });

  await check('users.get failure does not discard valid bids or prevent processing', async () => {
    const { value, auction } = seedAuction(8002, true);
    respond = async () => ({ error: { error_code: 9, error_msg: 'Flood control' } });
    const items = [{ id: 6001, from_id: 9876,
      date: Date.parse('2026-09-13T12:00:00+03:00') / 1000, text: '500' }];
    assert.equal(await pollAuction(value, { now: new Date('2026-09-13T12:01:00+03:00'), readComments: commentsPage(items) }), true);
    assert.equal(store.getLotState(auction.id, 1).leader_name, 'id9876');
    assert.equal(store.getLotState(auction.id, 1).current_price, 500);
    assert.equal(db.prepare('SELECT vk_error_code FROM vk_api_usage ORDER BY id DESC LIMIT 1').get().vk_error_code, 9);
  });

  await check('successful name batches remain cached when the next batch fails', async () => {
    store.saveWorkerState('vk:service:users.get', { failures: 0, until: 0 });
    const { value } = seedAuction(8010);
    let nameRequests = 0;
    respond = async (method, params) => {
      assert.equal(method, 'users.get');
      if (++nameRequests === 2) return { error: { error_code: 9 } };
      return { response: params.user_ids.split(',').map((id) => ({ id: Number(id), first_name: 'Name', last_name: 'Cached' })) };
    };
    const items = Array.from({ length: 1001 }, (_, i) => ({ id: 30000 + i,
      from_id: 20000 + i, date: Date.parse('2026-09-13T12:00:00+03:00') / 1000, text: 'not a bid' }));
    await processAuctionComments({ postId: value.id, postDate: value.date, comments: items });
    assert.equal(store.getCachedVkUsers(items.map((item) => item.from_id)).length, 1000);
    await processAuctionComments({ postId: value.id, postDate: value.date,
      comments: [{ ...items[0], id: 31002, text: 'not a bid' }] });
    assert.equal(nameRequests, 2);
  });

  await check('failed page prevents closing; offline extension is reconciled before winner detection', async () => {
    const { value, auction } = seedAuction(8003);
    seedLot(auction.id);
    const now = new Date('2026-09-13T20:05:00+03:00');
    let finalizations = 0;
    assert.equal(await pollAuction(value, { now,
      readComments: async () => { throw new vk.VkApiError('timeout', { temporary: true }); },
      finalize: async () => { finalizations += 1; }
    }), false);
    assert.equal(finalizations, 0);
    assert.equal(store.getLotState(auction.id, 1).is_closed, 0);
    const items = [{ id: 7001, from_id: 10, date: Date.parse('2026-09-13T19:58:00+03:00') / 1000, text: '1-500' }];
    assert.equal(await pollAuction(value, { now, readComments: commentsPage(items) }), true);
    assert.equal(store.getLotState(auction.id, 1).ends_at, '2026-09-13T17:18:00.000Z');
    assert.equal(store.getLotState(auction.id, 1).is_closed, 0);
    config.autoReply = true;
    await pollAuction(value, { now: new Date('2026-09-13T20:20:00+03:00'), readComments: commentsPage(items) });
    assert.equal(store.getLotState(auction.id, 1).is_closed, 1);
    assert.equal(store.getLotState(auction.id, 1).winner_notified, 1);
    await pollAuction(value, { now: new Date('2026-09-13T20:49:00+03:00'), readComments: commentsPage(items) });
    assert.equal(store.getAuctionPollState(auction.id).status, 'stopped');
    await pollAuction(value, { now: new Date('2026-09-14T12:00:00+03:00'),
      readComments: async () => { assert.fail('stopped auctions must not be polled'); } });
    assert.equal(store.getLotState(auction.id, 1).current_price, 500);
    config.autoReply = false;
  });

  await check('saved auction is polled even when wall discovery fails', async () => {
    db.prepare("UPDATE auction_poll_state SET status = 'stopped'").run();
    const { value, auction } = seedAuction(8004);
    respond = async (method) => method === 'wall.get'
      ? { error: { error_code: 9 } } : { response: { items: [] } };
    const discoveryCallsBefore = requests.filter((request) => request.method === 'wall.get').length;
    await tick(new Date('2026-09-13T12:00:00+03:00'));
    assert.ok(store.getAuctionPollState(auction.id).last_successful_poll);
    assert.ok(store.getWorkerState('auction_discovery').failures);
    assert.equal(JSON.parse(store.getAuctionPollState(auction.id).post_json).id, value.id);
    const discoveryCallsAfterStartup = requests.filter((request) => request.method === 'wall.get').length;
    assert.equal(discoveryCallsAfterStartup, discoveryCallsBefore + 1);
    await tick(new Date('2026-09-13T12:05:00+03:00'));
    assert.equal(requests.filter((request) => request.method === 'wall.get').length, discoveryCallsAfterStartup);
  });

  await check('legacy SQLite auction missing from recent wall is recovered with the same discovery filter', async () => {
    store.saveWorkerState('vk:service:wall.get', { failures: 0, until: 0 });
    const { getAuctionPosts } = await import('../src/auctionPosts.js');
    respond = async (method, params) => {
      if (method === 'wall.get') return { response: { items: [post(9010)] } };
      assert.equal(method, 'wall.getById');
      assert.equal(params.access_token, 'mock-service');
      assert.equal(params.posts, '-57561517_9011,-57561517_9012');
      return { response: { items: [post(9011, true), { ...post(9012), text: 'unrelated post' }] } };
    };
    const found = await getAuctionPosts({ recoverPostIds: [9011, 9012] });
    assert.deepEqual(found.map((item) => item.id), [9010, 9011]);
  });

  await check('08/17 reminder windows, package text/image/link/hashtag, deduplication and no wall.post', async () => {
    assert.equal(getReminderSchedule(new Date('2026-09-13T08:59:00+03:00')).scheduleTime, '08:00');
    assert.equal(getReminderSchedule(new Date('2026-09-13T17:59:00+03:00')).scheduleTime, '17:00');
    assert.equal(getReminderSchedule(new Date('2026-09-13T09:00:00+03:00')), null);
    assert.equal(getReminderSchedule(new Date('2026-09-13T19:35:00+03:00')).type, 'happy_santa_only');
    const { value, auction } = seedAuction(8005, true);
    value.attachments = [{ type: 'doc' }, { type: 'photo', photo: { owner_id: -57561517, id: 11 } },
      { type: 'photo', photo: { owner_id: -57561517, id: 12 } }];
    seedLot(auction.id, 1, 500);
    seedLot(auction.id, 2, 900);
    const before = requests.length;
    config.dryRun = false; // Safe: only PackageOnlyPublisher is reachable.
    for (const time of ['08:00', '17:00']) {
      const now = new Date(`2026-09-13T${time}:00+03:00`);
      await runAuctionReminders(time, now, { auctionPosts: [value] });
      await runAuctionReminders(time, now, { auctionPosts: [value] });
      const saved = store.getReminderPackage(auction.id, time);
      const payload = JSON.parse(saved.payload_json);
      assert.equal(saved.status, 'pending');
      assert.equal(store.getAuctionReminderRecord({ auctionId: auction.id, scheduleTime: time }).reminder_post_id, null);
      assert.deepEqual(payload.attachments, ['photo-57561517_11']);
      assert.ok(payload.message.includes('#CP_НапоминаниеАукциона'));
      assert.ok(payload.message.includes('https://vk.com/wall-57561517_8005'));
      assert.ok(payload.message.includes('1 - 500'));
      assert.ok(!payload.message.includes('2 - 900'));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminder_packages WHERE auction_id = ?').get(auction.id).n, 2);
    assert.equal(requests.length, before);
    const empty = seedAuction(8006);
    await runAuctionReminders('08:00', new Date('2026-09-13T08:00:00+03:00'), { auctionPosts: [empty.value] });
    assert.equal(store.getReminderPackage(empty.auction.id, '08:00'), undefined);
    await cleanupFinishedAuctionReminders(new Date('2026-09-13T21:00:00+03:00'), [value], { onlyProvidedPosts: true });
    assert.equal(store.getReminderPackage(auction.id, '08:00').status, 'expired');
    assert.equal(requests.length, before);
    config.dryRun = true;
  });

  await check('status and api-usage CLI do not start worker or require USER token', async () => {
    for (const command of ['status', 'api-usage']) {
      const child = spawnSync(process.execPath, ['src/index.js', command], {
        env: process.env, encoding: 'utf8', timeout: 20000
      });
      assert.equal(child.status, 0, child.stderr);
      assert.ok(!child.stdout.includes('Starting scheduler'));
      assert.ok(!child.stdout.includes('mock-service'));
      assert.ok(child.stdout.includes(command === 'status' ? 'Last processed comment:' : 'Current calendar month'));
    }
  });

  await check('automatic backup only on schema change; read-only status never migrates', async () => {
    const legacyPath = join(testDir, 'legacy.db');
    await db.backup(legacyPath);
    const legacy = new Database(legacyPath);
    for (const name of ['auction_poll_state', 'worker_state', 'vk_api_usage', 'reminder_packages']) legacy.exec(`DROP TABLE ${name}`);
    legacy.close();
    const env = { SQLITE_PATH: legacyPath, SQLITE_BACKUP_DIR: join(testDir, 'legacy-backups') };
    const readonly = spawnSync(process.execPath, ['src/index.js', 'status'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });
    assert.equal(readonly.status, 0, readonly.stderr);
    assert.ok(readonly.stdout.includes('migration not applied'));
    assert.equal(existsSync(env.SQLITE_BACKUP_DIR), false);
    runChild("const {db} = await import('./src/db.js'); db.close();", env);
    const backups = readdirSync(env.SQLITE_BACKUP_DIR);
    assert.equal(backups.length, 1);
    const backup = new Database(join(env.SQLITE_BACKUP_DIR, backups[0]), { readonly: true });
    assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'auction_poll_state'").get().n, 0);
    assert.ok(backup.prepare('SELECT COUNT(*) AS n FROM bids').get().n > 0);
    backup.close();
    runChild("const {db} = await import('./src/db.js'); db.close();", env);
    assert.equal(readdirSync(env.SQLITE_BACKUP_DIR).length, 1);
  });

  await check('startup validation aborts before scheduler and graceful scheduler stop drains work', async () => {
    const failed = spawnSync(process.execPath, ['src/index.js'], {
      env: { ...process.env, VK_SERVICE_TOKEN: '' }, encoding: 'utf8', timeout: 20000
    });
    assert.equal(failed.status, 1);
    assert.ok(failed.stderr.includes('VK_SERVICE_TOKEN'));
    assert.ok(!failed.stdout.includes('Starting scheduler'));
    const valid = spawnSync(process.execPath, ['src/index.js', '--check-config'], { env: process.env, encoding: 'utf8', timeout: 20000 });
    assert.equal(valid.status, 0, valid.stderr);
    assert.ok(valid.stdout.includes('Configuration OK'));
    const legacyPublisher = spawnSync(process.execPath, ['src/index.js', '--check-config'], {
      env: { ...process.env, REMINDER_PUBLISHER: 'existing-vk-wall' }, encoding: 'utf8', timeout: 20000
    });
    assert.equal(legacyPublisher.status, 1);
    config.auctionRemindersEnabled = false;
    db.prepare("UPDATE auction_poll_state SET status = 'stopped'").run();
    store.saveWorkerState('auction_discovery', { nextAt: Date.now() + 3600000, failures: 0 });
    const before = requests.length;
    const stop = startScheduler();
    await stop();
    assert.equal(requests.length, before);
  });

  await check('model API baseline using the implemented polling schedule', async () => {
    let time = new Date('2026-09-13T00:00:00+03:00');
    let count = 0;
    const closeAt = Date.parse('2026-09-13T20:00:00+03:00');
    while (time < new Date('2026-09-14T00:00:00+03:00')) {
      count += 1;
      const plan = getPollingPlan({ postDate: '2026-09-12T07:00:00.000Z',
        summaryRows: [{ is_closed: time.getTime() >= closeAt ? 1 : 0 }],
        lastSuccessfulPoll: time.toISOString()
      }, time);
      if (plan.status === 'stopped') break;
      time = new Date(Math.min(time.getTime() + plan.intervalMs, plan.nextBoundary ?? Infinity));
    }
    assert.equal(count, 129);
    console.log(`Modeled ending-auction polls/day: ${count}; plus at most 14 discovery slots, 3 reminder lookups and about 36 polls for a new 18:00 auction: up to ${count + 53}. Excludes users, writes, pagination, failures and restarts.`);
  });

  assert.equal(requests.filter((request) => request.method === 'wall.post').length, 0);
  console.log(`Migration tests passed: ${passed}. Real network requests: 0. wall.post calls: 0.`);
} finally {
  db.close();
  rmSync(testDir, { recursive: true, force: true });
}
