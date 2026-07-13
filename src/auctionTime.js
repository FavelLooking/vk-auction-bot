export const MOSCOW_TIME_ZONE = 'Europe/Moscow';

export function getMoscowDateParts(value) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

export function getMoscowDateKey(value) {
  const parts = getMoscowDateParts(value);

  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

export function getAuctionBaseEndIso(postDateIso) {
  if (!postDateIso) return null;

  const post = getMoscowDateParts(postDateIso);

  // TODO: Keep this aligned with the production auction rules if the end time changes.
  const end = new Date(
    `${String(post.year).padStart(4, '0')}-${String(post.month).padStart(2, '0')}-${String(post.day).padStart(2, '0')}T20:00:00+03:00`
  );

  end.setUTCDate(end.getUTCDate() + 1);

  return end.toISOString();
}

export function getAuctionEffectiveEndIso(postDateIso, summaryRows = []) {
  const timestamps = [];
  const baseEndIso = getAuctionBaseEndIso(postDateIso);

  if (baseEndIso) {
    timestamps.push(new Date(baseEndIso).getTime());
  }

  for (const row of summaryRows) {
    if (!row.is_closed && row.ends_at) {
      timestamps.push(new Date(row.ends_at).getTime());
    }
  }

  if (!timestamps.length) return null;

  return new Date(Math.max(...timestamps)).toISOString();
}
