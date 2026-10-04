import { config } from './config.js';
import { getMoscowDateKey, getMoscowTime, shiftDateKey } from './auctionTime.js';

function clockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function slotKey(dateKey, time) {
  return `${dateKey}T${String(time.getUTCHours() + 3).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')}`;
}

function windowFor(dateKey, settings) {
  const startMinutes = clockMinutes(settings.auctionDiscoveryStart);
  const endMinutes = clockMinutes(settings.auctionDiscoveryEnd);
  return {
    start: getMoscowTime(dateKey, Math.floor(startMinutes / 60), startMinutes % 60),
    end: getMoscowTime(dateKey, Math.floor(endMinutes / 60), endMinutes % 60)
  };
}

function nextWindowStart(dateKey, settings) {
  return windowFor(shiftDateKey(dateKey, 1), settings).start.getTime();
}

export function isPostFromMoscowDate(post, dateKey) {
  if (!Number.isFinite(post?.date)) return false;
  return getMoscowDateKey(new Date(post.date * 1000)) === dateKey;
}

export function hasKnownAuctionForDate(auctions, dateKey) {
  return auctions.some((auction) => auction.post_date && getMoscowDateKey(auction.post_date) === dateKey);
}

export function getDiscoveryPlan(now = new Date(), state = {}, options = {}, settings = config) {
  const nowMs = now.getTime();
  const dateKey = getMoscowDateKey(now);
  const { start, end } = windowFor(dateKey, settings);
  const intervalMs = settings.auctionDiscoveryMs;
  const startup = options.startup === true;
  const todayDiscovered = options.todayDiscovered === true || state.discoveredDateKey === dateKey;

  if (startup) {
    const scheduled = getDiscoveryPlan(now, state, { startup: false, todayDiscovered }, settings);
    return { ...scheduled, due: true, reason: 'startup recovery' };
  }

  if (todayDiscovered) {
    return { due: false, reason: 'today auction already discovered', dateKey, slotKey: null,
      nextAt: nextWindowStart(dateKey, settings) };
  }

  if (nowMs < start.getTime()) {
    return { due: false, reason: 'before discovery window', dateKey, slotKey: null, nextAt: start.getTime() };
  }

  // The configured end is the final slot, not an open-ended interval.
  if (nowMs >= end.getTime() + 60_000) {
    return { due: false, reason: 'after discovery window', dateKey, slotKey: null,
      nextAt: nextWindowStart(dateKey, settings) };
  }

  const elapsed = nowMs - start.getTime();
  const index = Math.floor(elapsed / intervalMs);
  const currentSlot = new Date(start.getTime() + index * intervalMs);
  const currentSlotKey = slotKey(dateKey, currentSlot);
  const withinSlotMinute = nowMs >= currentSlot.getTime() && nowMs < currentSlot.getTime() + 60_000;
  const nextSlot = currentSlot.getTime() + intervalMs <= end.getTime()
    ? currentSlot.getTime() + intervalMs
    : nextWindowStart(dateKey, settings);
  const pendingAt = Number(state.nextAt || 0);
  const alreadyAttempted = state.lastAttemptedSlot === currentSlotKey;
  const waitingForLater = pendingAt > nowMs;

  return {
    due: withinSlotMinute && !alreadyAttempted && !waitingForLater,
    reason: withinSlotMinute ? 'scheduled discovery slot' : 'between discovery slots',
    dateKey,
    slotKey: currentSlotKey,
    nextAt: withinSlotMinute ? nextSlot : Math.min(nextSlot, currentSlot.getTime() + intervalMs)
  };
}
