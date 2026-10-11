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

// 1-4-200  => 1..4 по 200
function parseLotRangeSamePrice(line) {
  const match = line.match(/^(\d+)\s*-\s*(\d+)\s*-\s*(\d+)$/);
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
  const match = line.match(/^(\d+(?:\s*,\s*\d+)+)\s*-\s*(\d+)$/);
  if (!match) return null;

  const rawLots = match[1]
    .split(',')
    .map((x) => Number(x.trim()));

  const amount = Number(match[2]);

  if (!rawLots.every((lot) => isPositiveInt(lot)) || !isPositiveInt(amount)) {
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
    /^(\d+)\s*-\s*(\d+)$/,
    /^(\d+)\s*\.\s*(\d+)$/,
    /^(\d+)\s+(\d+)$/,
    /^лот\s*(\d+)\s*-\s*(\d+)$/i,
    /^лот\s*(\d+)\s+(\d+)$/i
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) continue;

    const lot = Number(match[1]);
    const amount = Number(match[2]);

    if (!isPositiveInt(lot) || !isPositiveInt(amount)) {
      continue;
    }

    return [{
      lot,
      amount,
      confidence: 'single'
    }];
  }

  return null;
}

function parseExactExpression(expression) {
  return (
    parseLotRangeSamePrice(expression) ||
    parseMultiLotSamePrice(expression) ||
    parseSingleLot(expression)
  );
}

function looksLikeBidFragment(value) {
  const candidate = value.replace(/^[\s,.;]+/, '');
  return (
    /^(?:лот\s*)?\d+/i.test(candidate) ||
    /(?:^|\s)(?:лот\s*)?\d+\s*(?:-|\.|\s)\s*\d+/i.test(candidate)
  );
}

function splitIndependentExpressions(line) {
  const expressions = [];
  let remaining = line;

  while (remaining) {
    let splitAt = -1;

    for (let index = 0; index < remaining.length; index += 1) {
      if (remaining[index] !== ',' && remaining[index] !== ';') continue;

      const left = remaining.slice(0, index).trim();
      const right = remaining.slice(index + 1).trim();

      // A comma inside `1,4-200` is part of the existing multi-lot syntax:
      // split only after the left side already forms a complete bid expression.
      if (parseExactExpression(left) && looksLikeBidFragment(right)) {
        splitAt = index;
        break;
      }
    }

    if (splitAt < 0) {
      expressions.push(remaining.trim());
      break;
    }

    expressions.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }

  return expressions.filter(Boolean);
}

function parseExpressionWithTail(expression) {
  const exact = parseExactExpression(expression);
  if (exact) {
    return { bids: exact, failed: null };
  }

  // Preserve the historical allowance for harmless trailing prose, but never
  // silently discard a suffix that starts like another lot/bid.
  for (let index = expression.length - 1; index > 0; index -= 1) {
    const prefix = expression
      .slice(0, index)
      .trim()
      .replace(/[,.;]+$/, '')
      .trim();
    const bids = parseExactExpression(prefix);
    if (!bids) continue;

    const remainder = expression
      .slice(index)
      .replace(/^[\s,.;]+/, '')
      .trim();

    if (!remainder) {
      return { bids, failed: null };
    }

    return {
      bids,
      failed: looksLikeBidFragment(remainder) ? remainder : null
    };
  }

  return { bids: [], failed: expression };
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

    for (const expression of splitIndependentExpressions(line)) {
      const result = parseExpressionWithTail(expression);
      parsed.push(...result.bids);
      if (result.failed) failedLines.push(result.failed);
    }
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
