import assert from 'node:assert/strict';
import { parseCommentText } from '../src/parser.js';
import {
  filterSingleAuctionSummaryRows,
  isSingleAuctionLotSelectionValid,
  parseSingleAuctionBidAmount
} from '../src/singleAuctionParser.js';

const accepted = [
  ['50', 50],
  ['стартану 50 рублей', 50],
  ['ставлю 100', 100],
  ['моя ставка 150 ₽', 150],
  ['200р', 200],
  ['СТАВЛЮ 100', 100],
  ['Стартану 50 рублей', 50]
];

for (const [text, amount] of accepted) {
  const result = parseSingleAuctionBidAmount(text);

  assert.equal(result?.status, 'valid', `${text} should be accepted`);
  assert.deepEqual(result?.bids, [
    {
      lot: 1,
      amount,
      confidence: 'single_auction'
    }
  ]);
}

const rejected = [
  'мне 50 лет',
  'выпуск 2000 года',
  '50 или 100',
  'лот 2 за 500',
  'буду после 18'
];

for (const text of rejected) {
  assert.equal(parseSingleAuctionBidAmount(text), null, `${text} should be rejected`);
}

const acceptedLotSelections = [
  '1-500'
];

for (const text of acceptedLotSelections) {
  assert.equal(
    isSingleAuctionLotSelectionValid(parseCommentText(text)),
    true,
    `${text} should be a valid single-auction lot selection`
  );
}

const rejectedLotSelections = [
  '2-500',
  '3-700',
  '2,3-800',
  '1,2-900',
  '2-4-1000'
];

for (const text of rejectedLotSelections) {
  assert.equal(
    isSingleAuctionLotSelectionValid(parseCommentText(text)),
    false,
    `${text} should be an invalid single-auction lot selection`
  );
}

assert.deepEqual(
  filterSingleAuctionSummaryRows([
    { lot_number: 1, current_price: 500 },
    { lot_number: 2, current_price: 800 },
    { lot_number: 3, current_price: 1000 }
  ]),
  [{ lot_number: 1, current_price: 500 }]
);

console.log('single auction parser tests passed');
