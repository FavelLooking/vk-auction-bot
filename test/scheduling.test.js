import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const testDir = mkdtempSync(join(tmpdir(), 'vk-auction-scheduling-'));
Object.assign(process.env, {
  SQLITE_PATH: join(testDir, 'auction.db'),
  SQLITE_BACKUP_DIR: join(testDir, 'backups'),
  VK_GROUP_ID: '57561517'
});

const { getPollingPlan } = await import('../src/auctionPolling.js');
const { getDiscoveryPlan, hasKnownAuctionForDate } = await import('../src/auctionDiscovery.js');
const store = await import('../src/db.js');

const settings = {
  pollInitialMs: 600_000,
  pollInitialWindowMs: 10_800_000,
  pollQuietMs: 3_600_000,
  pollDayMs: 1_800_000,
  pollActiveMs: 600_000,
  pollApproachingMs: 120_000,
  pollClosingMs: 60_000,
  pollDeadlineMs: 15_000,
  pollGraceMs: 300_000,
  pollGraceWindowMs: 1_800_000,
  pollApproachingWindowMs: 7_200_000,
  pollClosingWindowMs: 1_800_000,
  pollDeadlineWindowMs: 300_000,
  auctionDiscoveryStart: '18:01',
  auctionDiscoveryEnd: '20:11',
  auctionDiscoveryMs: 600_000
};

const at = (value) => new Date(`${value}+03:00`);
const standardPostDate = '2026-10-01T15:00:00.000Z'; // 18:00 MSK; closes next day 20:00 MSK.

test('bid polling follows age, Moscow daytime and effective-deadline priority', () => {
  assert.equal(getPollingPlan({ postDate: '2026-10-02T15:00:00.000Z' }, at('2026-10-02T19:00:00')).intervalMs, 600_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-01T21:30:00')).intervalMs, 3_600_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-01T23:30:00')).intervalMs, 3_600_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T07:30:00')).intervalMs, 3_600_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T03:00:00')).intervalMs, 3_600_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T10:00:00')).intervalMs, 1_800_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T16:59:00')).intervalMs, 1_800_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T17:00:00')).intervalMs, 600_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T18:00:00')).intervalMs, 120_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T19:30:00')).intervalMs, 60_000);
  assert.equal(getPollingPlan({ postDate: standardPostDate }, at('2026-10-02T19:55:00')).intervalMs, 15_000);

  const extended = { postDate: standardPostDate, summaryRows: [{ is_closed: 0, ends_at: '2026-10-02T22:00:00+03:00' }] };
  assert.equal(getPollingPlan(extended, at('2026-10-02T20:00:00')).intervalMs, 120_000);

  const youngButClosing = { postDate: '2026-10-02T16:00:00.000Z',
    summaryRows: [{ is_closed: 0, ends_at: '2026-10-02T19:30:00+03:00' }] };
  assert.equal(getPollingPlan(youngButClosing, at('2026-10-02T19:25:00')).intervalMs, 15_000);
});

test('post-deadline polling reconciles for 30 minutes and then stops', () => {
  const closed = { postDate: standardPostDate,
    summaryRows: [{ is_closed: 1, ends_at: '2026-10-02T20:00:00+03:00' }] };
  const grace = getPollingPlan(closed, at('2026-10-02T20:10:00'));
  assert.equal(grace.intervalMs, 300_000);
  assert.equal(grace.status, 'reconciling');

  const stopped = getPollingPlan({ ...closed, lastSuccessfulPoll: '2026-10-02T20:31:00+03:00' }, at('2026-10-02T20:31:00'));
  assert.equal(stopped.status, 'stopped');
});

test('scheduled discovery uses only configured Moscow slots', () => {
  assert.equal(getDiscoveryPlan(at('2026-10-02T17:59:00'), {}, {}, settings).due, false);
  assert.equal(getDiscoveryPlan(at('2026-10-02T18:01:00'), {}, {}, settings).due, true);
  assert.equal(getDiscoveryPlan(at('2026-10-02T18:11:00'), {}, {}, settings).due, true);
  assert.equal(getDiscoveryPlan(at('2026-10-02T18:05:00'), {}, {}, settings).due, false);
  assert.equal(getDiscoveryPlan(at('2026-10-02T20:11:00'), {}, {}, settings).due, true);
  assert.equal(getDiscoveryPlan(at('2026-10-02T20:12:00'), {}, {}, settings).due, false);
});

test('discovery stops after today is found and resets next Moscow day', () => {
  const found = { discoveredDateKey: '2026-10-02' };
  assert.equal(getDiscoveryPlan(at('2026-10-02T18:11:00'), found, {}, settings).due, false);
  assert.equal(getDiscoveryPlan(at('2026-10-03T18:01:00'), found, {}, settings).due, true);
});

test('startup allows exactly one immediate recovery plan and registration stays idempotent', () => {
  const first = getDiscoveryPlan(at('2026-10-02T11:00:00'), {}, { startup: true }, settings);
  assert.equal(first.due, true);
  const afterStartup = getDiscoveryPlan(at('2026-10-02T11:00:00'), { nextAt: first.nextAt }, {}, settings);
  assert.equal(afterStartup.due, false);

  const post = { id: 136915, date: Date.parse('2026-10-01T18:00:00+03:00') / 1000, text: '#cp_аукцион' };
  store.registerPollingPost(post);
  store.registerPollingPost(post);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM auctions WHERE post_id = ?').get(post.id).n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM auction_poll_state').get().n, 1);
});

test('restart uses persisted auction date and does not resume scheduled discovery that evening', () => {
  const post = { id: 136916, date: Date.parse('2026-10-02T18:00:00+03:00') / 1000, text: '#cp_аукцион' };
  store.registerPollingPost(post);

  const dateKey = '2026-10-02';
  const knownToday = hasKnownAuctionForDate(store.getPollingAuctions(), dateKey);
  assert.equal(knownToday, true);

  const startup = getDiscoveryPlan(at('2026-10-02T19:00:00'), {}, { startup: true, todayDiscovered: knownToday }, settings);
  assert.equal(startup.due, true);
  assert.equal(startup.nextAt, at('2026-10-03T18:01:00').getTime());

  const persisted = { nextAt: startup.nextAt, discoveredDateKey: dateKey };
  assert.equal(getDiscoveryPlan(at('2026-10-02T19:11:00'), persisted, {}, settings).due, false);
  assert.equal(getDiscoveryPlan(at('2026-10-02T20:11:00'), persisted, {}, settings).due, false);
});

test.after(() => {
  store.db.close();
  rmSync(testDir, { recursive: true, force: true });
});
