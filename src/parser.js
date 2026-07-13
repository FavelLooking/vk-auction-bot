function normalizeText(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/:/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLines(text) {
  return String(text || '')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

// допускаем хвост: запятая, точка, точка с запятой, текст
const TAIL = String.raw`(?:[\s,.;]*.*)?$`;

// 1-4-200  => 1..4 по 200
function parseLotRangeSamePrice(line) {
  const match = line.match(new RegExp(`^(\\d+)\\s*-\\s*(\\d+)\\s*-\\s*(\\d+)${TAIL}`));
  if (!match) return null;

  const startLot = Number(match[1]);
  const endLot = Number(match[2]);
  const amount = Number(match[3]);

  if (!isPositiveInt(startLot) || !isPositiveInt(endLot) || !isPositiveInt(amount)) {
    return null;
  }

  if (startLot > endLot) {
    return null;
  }

  const bids = [];
  for (let lot = startLot; lot <= endLot; lot += 1) {
    bids.push({
      lot,
      amount,
      confidence: 'range'
    });
  }

  return bids;
}

// 1,4-200  => 1-200 и 4-200
function parseMultiLotSamePrice(line) {
  const match = line.match(new RegExp(`^([\\d,\\s]+)\\s*-\\s*(\\d+)${TAIL}`));
  if (!match) return null;

  const rawLots = match[1]
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => isPositiveInt(n));

  const amount = Number(match[2]);

  if (!rawLots.length || !isPositiveInt(amount)) {
    return null;
  }

  if (rawLots.length < 2) {
    return null;
  }

  return rawLots.map((lot) => ({
    lot,
    amount,
    confidence: 'multi'
  }));
}

// 1-300 / 1 300 / лот 1-300 / лот 1 300
function parseSingleLot(line) {
  const patterns = [
    new RegExp(`^(\\d+)\\s*-\\s*(\\d+)${TAIL}`),
    new RegExp(`^(\\d+)\\s+(\\d+)${TAIL}`),
    new RegExp(`^лот\\s*(\\d+)\\s*-\\s*(\\d+)${TAIL}`, 'i'),
    new RegExp(`^лот\\s*(\\d+)\\s+(\\d+)${TAIL}`, 'i')
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) continue;

    const lot = Number(match[1]);
    const amount = Number(match[2]);

    if (!isPositiveInt(lot) || !isPositiveInt(amount)) {
      continue;
    }

    return {
      lot,
      amount,
      confidence: 'single'
    };
  }

  return null;
}

function dedupeBids(bids) {
  const map = new Map();

  for (const bid of bids) {
    map.set(`${bid.lot}:${bid.amount}`, bid);
  }

  return [...map.values()].sort((a, b) => a.lot - b.lot || a.amount - b.amount);
}

export function parseCommentText(text) {
  const lines = normalizeLines(text);
  const parsed = [];
  const failedLines = [];

  for (let line of lines) {
    line = normalizeText(line);

    const range = parseLotRangeSamePrice(line);
    if (range) {
      parsed.push(...range);
      continue;
    }

    const multi = parseMultiLotSamePrice(line);
    if (multi) {
      parsed.push(...multi);
      continue;
    }

    const single = parseSingleLot(line);
    if (single) {
      parsed.push(single);
      continue;
    }

    failedLines.push(line);
  }

  if (!parsed.length) {
    return {
      status: 'invalid',
      bids: [],
      failedLines,
      reason: 'no_bids_found'
    };
  }

  return {
    status: failedLines.length ? 'partial' : 'valid',
    bids: dedupeBids(parsed),
    failedLines,
    reason: failedLines.length ? 'some_lines_unparsed' : null
  };
}