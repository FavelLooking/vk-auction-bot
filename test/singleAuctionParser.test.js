import assert from 'node:assert/strict';
import { parseCommentText } from '../src/parser.js';
import {
  filterSingleAuctionSummaryRows,
  isSingleAuctionLotSelectionValid,
  parseSingleAuctionBidAmount
} from '../src/singleAuctionParser.js';

const parserCases = [
  ['1.100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1 . 100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1.100\n2.100', [
    { lot: 1, amount: 100, confidence: 'single' },
    { lot: 2, amount: 100, confidence: 'single' }
  ]],
  ['1-100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1 - 100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1 100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['лот 1-100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['лот 1 100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1:100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1—100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1\u00a0-\u00a0100', [{ lot: 1, amount: 100, confidence: 'single' }]],
  ['1-3-200', [
    { lot: 1, amount: 200, confidence: 'range' },
    { lot: 2, amount: 200, confidence: 'range' },
    { lot: 3, amount: 200, confidence: 'range' }
  ]],
  ['1,3-200', [
    { lot: 1, amount: 200, confidence: 'multi' },
    { lot: 3, amount: 200, confidence: 'multi' }
  ]],
  ['1, 3, 4 - 200', [
    { lot: 1, amount: 200, confidence: 'multi' },
    { lot: 3, amount: 200, confidence: 'multi' },
    { lot: 4, amount: 200, confidence: 'multi' }
  ]],
  ['1,2,3,4,5,6 - 500р', [
    { lot: 1, amount: 500, confidence: 'multi' },
    { lot: 2, amount: 500, confidence: 'multi' },
    { lot: 3, amount: 500, confidence: 'multi' },
    { lot: 4, amount: 500, confidence: 'multi' },
    { lot: 5, amount: 500, confidence: 'multi' },
    { lot: 6, amount: 500, confidence: 'multi' }
  ]],
  ['2-400, 3-400', [
    { lot: 2, amount: 400, confidence: 'single' },
    { lot: 3, amount: 400, confidence: 'single' }
  ]],
  ['2-400; 4-400', [
    { lot: 2, amount: 400, confidence: 'single' },
    { lot: 4, amount: 400, confidence: 'single' }
  ]],
  ['1,4-200; 2-300', [
    { lot: 1, amount: 200, confidence: 'multi' },
    { lot: 2, amount: 300, confidence: 'single' },
    { lot: 4, amount: 200, confidence: 'multi' }
  ]],
  ['1-200, 2,4-300', [
    { lot: 1, amount: 200, confidence: 'single' },
    { lot: 2, amount: 300, confidence: 'multi' },
    { lot: 4, amount: 300, confidence: 'multi' }
  ]],
  ['2-400, 2-400', [{ lot: 2, amount: 400, confidence: 'single' }]],
  ['2-400, спасибо', [{ lot: 2, amount: 400, confidence: 'single' }]],
  ['2-400; удачи', [{ lot: 2, amount: 400, confidence: 'single' }]],
  ['2-400 ставка', [{ lot: 2, amount: 400, confidence: 'single' }]]
];

for (const [text, bids] of parserCases) {
  const result = parseCommentText(text);
  assert.equal(result.status, 'valid', `${text} should be valid`);
  assert.deepEqual(result.bids, bids);
}

const partialParserCases = [
  ['2-400, 3-abc', [{ lot: 2, amount: 400, confidence: 'single' }], ['3-abc']],
  ['2-400; лот 3', [{ lot: 2, amount: 400, confidence: 'single' }], ['лот 3']],
  ['2-400 3-500', [{ lot: 2, amount: 400, confidence: 'single' }], ['3-500']],
  ['2-400 и 3-500', [{ lot: 2, amount: 400, confidence: 'single' }], ['и 3-500']],
  ['2-400. 3-500', [{ lot: 2, amount: 400, confidence: 'single' }], ['3-500']],
  ['2-400, 3-400, 4-x', [
    { lot: 2, amount: 400, confidence: 'single' },
    { lot: 3, amount: 400, confidence: 'single' }
  ], ['4-x']]
];

for (const [text, bids, failedLines] of partialParserCases) {
  const result = parseCommentText(text);
  assert.equal(result.status, 'partial', `${text} should be partial`);
  assert.deepEqual(result.bids, bids);
  assert.deepEqual(result.failedLines, failedLines);
  assert.equal(result.reason, 'some_lines_unparsed');
}

for (const text of ['ставка', '3-abc', 'лот 3']) {
  const result = parseCommentText(text);
  assert.equal(result.status, 'invalid', `${text} should be invalid`);
  assert.deepEqual(result.bids, []);
  assert.deepEqual(result.failedLines, [text]);
}

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
