import assert from 'node:assert/strict';
import { parseSingleAuctionBidAmount } from '../src/singleAuctionParser.js';

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

console.log('single auction parser tests passed');
