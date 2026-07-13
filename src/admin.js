import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  getRecentAuctionsForAdmin,
  getAuctionById,
  getLotsForAdmin,
  getBidHistoryForLot,
  getCurrentSummary,
  voidBidAndRecalculateLot
} from './db.js';
import { publishOrRefreshSummary } from './auctionService.js';
import { logger } from './logger.js';
import { config } from './config.js';

const rl = readline.createInterface({ input, output });
const colorsEnabled = Boolean(output.isTTY && !process.env.NO_COLOR);

const color = {
  green(text) {
    return colorsEnabled ? `\x1b[32m${text}\x1b[0m` : text;
  },
  yellow(text) {
    return colorsEnabled ? `\x1b[33m${text}\x1b[0m` : text;
  },
  red(text) {
    return colorsEnabled ? `\x1b[31m${text}\x1b[0m` : text;
  },
  dim(text) {
    return colorsEnabled ? `\x1b[2m${text}\x1b[0m` : text;
  }
};

function printRows(rows, formatter) {
  rows.forEach((row, index) => {
    console.log(`${index + 1}. ${formatter(row)}`);
  });
}

async function askChoice({ prompt, rows }) {
  while (true) {
    const answer = await rl.question(`${prompt} (1-${rows.length}, 0 to cancel): `);
    const choice = Number(answer.trim());

    if (choice === 0) {
      return null;
    }

    if (Number.isInteger(choice) && choice >= 1 && choice <= rows.length) {
      return rows[choice - 1];
    }

    console.log('Invalid choice.');
  }
}

async function askConfirmation(prompt) {
  const answer = await rl.question(`${prompt} Type "yes" to confirm: `);
  return answer.trim().toLowerCase() === 'yes';
}

function printDivider() {
  console.log('--------------------------------');
}

function printStatusBlock({ activeAuctionCount }) {
  printDivider();
  console.log('');
  console.log('VK Auction Admin');
  console.log('');
  console.log('Bot:');
  console.log(color.green('✅ Running'));
  console.log('');
  console.log('SQLite:');
  console.log(color.green('✅ Connected'));
  console.log('');
  console.log('Reminder Service:');
  console.log(
    config.auctionRemindersEnabled
      ? color.green('✅ Enabled')
      : color.yellow('🟡 Disabled')
  );
  console.log('');
  console.log('Active auctions:');
  console.log(String(activeAuctionCount));
  console.log('');
  printDivider();
  console.log('');
}

function formatAuction(auction) {
  const openLots = auction.open_lot_count ?? 0;
  const totalLots = auction.lot_count ?? 0;

  return [
    `auction_id=${auction.id}`,
    `post_id=${auction.post_id}`,
    `status=${auction.status}`,
    `lots=${openLots}/${totalLots} open`,
    `post_date=${auction.post_date || '-'}`
  ].join(' | ');
}

function formatBidStatus(status) {
  if (status === 'accepted') {
    return color.green('🟢 accepted');
  }

  if (status === 'voided') {
    return color.yellow('🟡 voided');
  }

  if (status === 'rejected') {
    return color.red('🔴 rejected');
  }

  return status;
}

function printLots(lots) {
  lots.forEach((lot, index) => {
    const leader = lot.leader_name || lot.leader_user_id || '-';
    const state = lot.is_closed ? color.red('closed') : color.green('open');

    console.log(`${index + 1}. Lot ${lot.lot_number}`);
    console.log('Current:');
    console.log(`${lot.current_price} ₽`);
    console.log('');
    console.log('Leader:');
    console.log(leader);
    console.log('');
    console.log('Status:');
    console.log(state);
    console.log('');
    console.log('----------------');
    console.log('');
  });
}

function printAuctionSummary(summaryRows) {
  if (!summaryRows.length) {
    console.log('No current bids in the auction summary.');
    return;
  }

  for (const row of summaryRows) {
    const name = row.leader_name ? ` (${row.leader_name})` : '';
    const marker = row.is_closed ? color.red('🔴') : color.green('🟢');
    console.log(`${marker} ${row.lot_number} - ${row.current_price} ₽${name}`);
  }
}

function formatLeader(state) {
  if (!state) {
    return 'No current leader.';
  }

  const leader = state.leader_name || state.leader_user_id || '-';
  return `${leader}\n${state.current_price} ₽`;
}

function formatBid(bid) {
  return [
    `bid_id=${bid.id}`,
    `comment_id=${bid.comment_id}`,
    `user=${bid.user_name || bid.user_id}`,
    `amount=${bid.amount}`,
    `status=${formatBidStatus(bid.status)}`,
    `created_at=${bid.created_at}`
  ].join(' | ');
}

async function main() {
  const auctions = getRecentAuctionsForAdmin();
  const activeAuctionCount = auctions.filter((auction) => auction.status === 'active').length;

  printStatusBlock({ activeAuctionCount });
  console.log('Manual bid void tool');
  console.log('');

  if (!auctions.length) {
    console.log('No active auctions found.');
    return;
  }

  console.log('Recent/active auctions:');
  printRows(auctions, formatAuction);
  console.log('');

  const auction = await askChoice({
    prompt: 'Select auction',
    rows: auctions
  });
  if (!auction) return;

  const lots = getLotsForAdmin(auction.id);
  if (!lots.length) {
    console.log('No lots found for this auction.');
    return;
  }

  console.log('');
  console.log(`Lots for auction ${auction.id}, post ${auction.post_id}:`);
  console.log('');
  printLots(lots);
  console.log('');

  const lot = await askChoice({
    prompt: 'Select lot',
    rows: lots
  });
  if (!lot) return;

  const bids = getBidHistoryForLot({
    auctionId: auction.id,
    lotNumber: lot.lot_number
  });

  if (!bids.length) {
    console.log('No bids found for this lot.');
    return;
  }

  console.log('');
  console.log('Current auction summary:');
  printAuctionSummary(getCurrentSummary(auction.id));

  console.log('');
  console.log(`Bid history for lot ${lot.lot_number}, newest first:`);
  printRows(bids, formatBid);
  console.log('');

  const bid = await askChoice({
    prompt: 'Select bid to void',
    rows: bids
  });
  if (!bid) return;

  if (bid.status === 'voided') {
    console.log(`Bid ${bid.id} is already voided.`);
    return;
  }

  const confirmed = await askConfirmation(
    `Void bid ${bid.id} on lot ${lot.lot_number} for ${bid.amount}?`
  );

  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  logger.warn(
    `ADMIN void bid requested: auction_id=${auction.id}, post_id=${auction.post_id}, lot=${lot.lot_number}, bid_id=${bid.id}, comment_id=${bid.comment_id}, amount=${bid.amount}, status=${bid.status}`
  );

  const result = voidBidAndRecalculateLot({ bidId: bid.id });

  if (result.nextLotState) {
    logger.warn(
      `ADMIN lot_state recalculated: auction_id=${auction.id}, lot=${lot.lot_number}, leader_bid_id=${result.nextLotState.bid_id}, current_price=${result.nextLotState.current_price}`
    );
  } else {
    logger.warn(
      `ADMIN lot_state removed: auction_id=${auction.id}, lot=${lot.lot_number}, no accepted bids remain`
    );
  }

  const freshAuction = getAuctionById(auction.id);
  await publishOrRefreshSummary(freshAuction.post_id, freshAuction.id);

  logger.warn(
    `ADMIN summary refreshed: auction_id=${freshAuction.id}, post_id=${freshAuction.post_id}`
  );

  console.log('');
  console.log(`Bid ${bid.id} marked as voided.`);
  console.log('');
  console.log('Previous leader:');
  console.log(formatLeader(result.previousLotState));
  console.log('');
  console.log('↓');
  console.log('');
  console.log('Current leader:');
  console.log(formatLeader(result.nextLotState));
  console.log('');
  console.log('Lot state recalculated.');
  console.log('Auction summary refreshed.');
  console.log('');
  console.log(color.green('Operation completed successfully.'));
}

main()
  .catch((error) => {
    logger.error('Admin command failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
