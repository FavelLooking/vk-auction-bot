const ALLOWED_SINGLE_AUCTION_WORDS = new Set([
  'дам',
  'мое',
  'мой',
  'моя',
  'р',
  'руб',
  'рублей',
  'рубля',
  'ставка',
  'ставку',
  'ставлю',
  'стартану',
  '₽'
]);

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .trim()
    .toLowerCase();
}

function getNumberMatches(text) {
  return [...text.matchAll(/\d+/g)];
}

function getRemainingWords(text, match) {
  const withoutAmount = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;

  return withoutAmount
    .replace(/[.,!?;:()[\]{}"'«»“”„`~*_=+\\/|<>—–-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function parseSingleAuctionBidAmount(text) {
  const normalized = normalizeText(text);
  const numberMatches = getNumberMatches(normalized);

  if (numberMatches.length !== 1) {
    return null;
  }

  const [match] = numberMatches;
  const amount = Number(match[0]);
  if (!Number.isInteger(amount) || amount <= 0) {
    return null;
  }

  const remainingWords = getRemainingWords(normalized, match);
  const hasOnlyAllowedWords = remainingWords.every((word) =>
    ALLOWED_SINGLE_AUCTION_WORDS.has(word)
  );

  if (!hasOnlyAllowedWords) {
    return null;
  }

  return {
    status: 'valid',
    bids: [
      {
        lot: 1,
        amount,
        confidence: 'single_auction'
      }
    ],
    failedLines: [],
    reason: 'single_auction_amount'
  };
}
