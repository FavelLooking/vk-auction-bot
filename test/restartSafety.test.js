import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), `vk-auction-bot-restart-safety-${process.pid}`);

rmSync(testDir, { recursive: true, force: true });

process.env.SQLITE_PATH = join(testDir, 'auction.db');
process.env.VK_SERVICE_TOKEN = 'test';
process.env.VK_GROUP_TOKEN = 'test';
process.env.VK_GROUP_ID = '57561517';
process.env.AUTO_REPLY = 'false';
process.env.AUCTION_REMINDERS_ENABLED = 'true';
process.env.REBUILD_MODE = 'false';
process.env.HS_API_TOKEN = 'test';
process.env.HS_AUCTION_LIST_ID = '1';

const {
  db,
  getOrCreateAuction,
  getLotState,
  saveBid,
  updateLotState
} = await import('../src/db.js');

const auction = getOrCreateAuction(
  57561517,
  999001,
  new Date('2026-07-12T10:00:00Z').toISOString(),
  new Date('2026-07-13T10:00:00Z').toISOString()
);

const winningBid = saveBid({
  auctionId: auction.id,
  commentId: 1,
  lotNumber: 1,
  userId: 10,
  userName: 'Winner',
  amount: 100,
  status: 'accepted'
});

updateLotState({
  auctionId: auction.id,
  lotNumber: 1,
  currentPrice: 100,
  leaderUserId: 10,
  leaderName: 'Winner',
  bidId: winningBid.id,
  isClosed: 1
});

const replayedBid = saveBid({
  auctionId: auction.id,
  commentId: 2,
  lotNumber: 1,
  userId: 11,
  userName: 'Replay',
  amount: 200,
  status: 'accepted'
});

updateLotState({
  auctionId: auction.id,
  lotNumber: 1,
  currentPrice: 200,
  leaderUserId: 11,
  leaderName: 'Replay',
  bidId: replayedBid.id,
  isClosed: 0
});

const state = getLotState(auction.id, 1);

assert.equal(state.current_price, 100);
assert.equal(state.leader_user_id, 10);
assert.equal(state.bid_id, winningBid.id);
assert.equal(state.is_closed, 1);

db.close();
rmSync(testDir, { recursive: true, force: true });

console.log('restart safety tests passed');
