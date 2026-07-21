import { config } from './config.js';
import {
  db,
  getOrCreateAuction,
  getLotState,
  getBidById,
  isCommentProcessed,
  saveBid,
  saveBotReply,
  saveProcessedComment,
  updateLotState,
  getCurrentSummary,
  getAuctionSummaryRecord,
  saveAuctionSummaryRecord,
  closeLot,
  getExpiredOpenLots,
  markWinnerNotified,
  getCachedVkUsers,
  saveCachedVkUsers
} from './db.js';
import { logger } from './logger.js';
import { parseCommentText } from './parser.js';
import {
  filterSingleAuctionSummaryRows,
  isSingleAuctionLotSelectionValid,
  parseSingleAuctionBidAmount
} from './singleAuctionParser.js';
import { parseCommentWithLmStudio } from './lmstudio.js';
import {
  getUserInfo,
  createComment,
  deleteComment,
  getVkBackoffUntil,
  isTemporaryVkError
} from './vk.js';

const userInfoCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUserName(comment, userMap) {
  if (comment.from_id < 0) return 'Сообщество';
  const user = userMap.get(comment.from_id);
  if (!user) return `id${comment.from_id}`;
  return `${user.first_name} ${user.last_name}`.trim();
}

function isVkFloodControlError(error) {
  return isTemporaryVkError(error) || /"error_code"\s*:\s*9/.test(String(error?.message || ''));
}

async function getCachedUserInfo(userIds) {
  const uniqueUserIds = [...new Set(userIds.filter((id) => id > 0))];
  let missingUserIds = uniqueUserIds.filter((id) => !userInfoCache.has(id));

  if (missingUserIds.length) {
    const dbUsers = getCachedVkUsers(missingUserIds);

    for (const user of dbUsers) {
      userInfoCache.set(user.id, user);
    }

    missingUserIds = uniqueUserIds.filter((id) => !userInfoCache.has(id));
  }

  if (missingUserIds.length && Date.now() >= getVkBackoffUntil()) {
    try {
      const users = await getUserInfo(missingUserIds);

      for (const user of users) {
        userInfoCache.set(user.id, user);
      }

      saveCachedVkUsers(users);
    } catch (error) {
      if (!isVkFloodControlError(error)) {
        throw error;
      }

      logger.warn(
        'VK users.get temporary failure; using cached names and id fallback for unknown users.'
      );
    }
  }

  return new Map(
    uniqueUserIds
      .map((id) => [id, userInfoCache.get(id)])
      .filter(([, user]) => user)
  );
}

function looksLikeBid(text) {
  return /\d/.test(String(text || ''));
}

function buildUserMention(userId, userName) {
  if (!userId || userId < 0) {
    return userName || 'Участник';
  }

  const safeName = String(userName || `id${userId}`).replace(/[\[\]\|]/g, '');
  return `[id${userId}|${safeName}]`;
}

function getMoscowDateParts(iso) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(new Date(iso));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function getAuctionBaseEndIso(postDateIso) {
  if (!postDateIso) return null;

  const post = getMoscowDateParts(postDateIso);

  // Аукцион всегда заканчивается на следующий день в 20:00 по Москве
  const end = new Date(
    `${String(post.year).padStart(4, '0')}-${String(post.month).padStart(2, '0')}-${String(post.day).padStart(2, '0')}T20:00:00+03:00`
  );

  end.setUTCDate(end.getUTCDate() + 1);

  return end.toISOString();
}

function isInExtensionPhase(postDateIso, bidDateIso) {
  if (!postDateIso || !bidDateIso) return false;

  const baseEndIso = getAuctionBaseEndIso(postDateIso);
  if (!baseEndIso) return false;

  const bidTime = new Date(bidDateIso).getTime();
  const extensionStart = new Date(baseEndIso).getTime() - 20 * 60 * 1000;

  return bidTime >= extensionStart;
}

function evaluateBid({ currentState, amount }) {
  if (currentState?.is_closed) {
    return { accepted: false, reason: 'lot_closed' };
  }

  if (!currentState) {
    return { accepted: true, reason: 'first_bid' };
  }

  const minAllowed = currentState.current_price + config.minBidStep;

  if (amount < minAllowed) {
    return {
      accepted: false,
      reason: `current_bid_${currentState.current_price}`
    };
  }

  return {
    accepted: true,
    reason: 'higher_bid'
  };
}

function buildClosedLotReply({ userId, userName, lot }) {
  const mention = buildUserMention(userId, userName);

  return `${mention}, ставка на лот ${lot} не принята.
Аукцион по этому лоту уже завершён.`;
}

function buildOutbidReply({ userId, userName, lot, newAmount, endsAt }) {
  const mention = buildUserMention(userId, userName);
  const nextMin = newAmount + config.minBidStep;

  if (endsAt) {
    const time = formatTime(endsAt);
    return `${mention}, ваша ставка на лот ${lot} перебита.
Аукцион по лоту продлён до ${time}.`;
  }

  return `${mention}, ваша ставка на лот ${lot} перебита.
Текущая ставка: ${newAmount} ₽.
Следующая минимальная ставка: ${nextMin} ₽.`;
}

function buildRejectedReply({ userId, userName, lot, currentAmount }) {
  const mention = buildUserMention(userId, userName);
  const nextMin = currentAmount + config.minBidStep;

  return `${mention}, ставка на лот ${lot} не принята.
Текущая ставка уже ${currentAmount} ₽.
Следующая минимальная ставка: ${nextMin} ₽.`;
}

function buildInvalidBidReply({ userId, userName }) {
  const mention = buildUserMention(userId, userName);

  return `${mention}, не удалось распознать ставку.
Используйте формат:
1-300
1,2-300
1-4-200

Шаг ставки: ${config.minBidStep} ₽`;
}

function buildInvalidSingleAuctionLotReply({ userId, userName }) {
  const mention = buildUserMention(userId, userName);

  return `${mention}, в одиночном аукционе можно делать ставки только на единственный лот.
Используйте формат:
500
или
1-500`;
}

function getSingleAuctionRejectReason(parseResult) {
  if (!parseResult?.bids?.length) {
    return 'invalid format';
  }

  return parseResult.bids.some((bid) => bid.lot !== 1)
    ? 'lot != 1'
    : 'none';
}

function logSingleAuctionDebug({ comment, isSingleAuction, mainParseResult, parseResult }) {
  const bids = (parseResult?.bids || []).map((bid) => ({
    lot: bid.lot,
    amount: bid.amount
  }));

  logger.info(`DEBUG Single auction comment:\ntext=${JSON.stringify(comment.text || '')}`);
  logger.info(`DEBUG isSingleAuction: ${isSingleAuction}`);
  logger.info(`DEBUG Main parser result:\n${JSON.stringify(mainParseResult, null, 2)}`);
  logger.info(`DEBUG Parse result:\n${JSON.stringify(bids, null, 2)}`);
  logger.info(`DEBUG Reject reason:\n${getSingleAuctionRejectReason(parseResult)}`);
}

function formatTime(iso) {
  if (!iso) return null;

  const date = new Date(iso);

  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildSummaryText(summaryRows) {
  if (!summaryRows.length) {
    return 'Ставок пока нет 😴';
  }

  const activeLines = [];
  const closedLines = [];

  for (const row of summaryRows) {
    const name = row.leader_name ? ` (${row.leader_name})` : '';

    if (row.is_closed) {
      closedLines.push(
        `🔴 ${row.lot_number} - ${row.current_price} ₽${name} завершён`
      );
      continue;
    }

    if (row.ends_at) {
      const time = formatTime(row.ends_at);
      activeLines.push(
        `🟡 ${row.lot_number} - ${row.current_price} ₽${name} продлён до ${time}`
      );
      continue;
    }

    activeLines.push(
      `🟢 ${row.lot_number} - ${row.current_price} ₽${name}`
    );
  }

  const lines = [];

  if (activeLines.length) {
    lines.push('Активные лоты:');
    lines.push(...activeLines);
  }

  if (closedLines.length) {
    lines.push('');
    lines.push('Завершённые:');
    lines.push(...closedLines);
  }

  return lines.join('\n');
}

async function safeReply({ postId, commentId, replyText }) {
  if (config.dryRun) {
    logger.info('[DRY_RUN] Reply to', commentId, 'in post', postId, ':', replyText);
    saveBotReply({ commentId, replyCommentId: null, replyText });
    return;
  }

  try {
    await sleep(config.replyDelayMs);

    const result = await createComment({
      groupId: config.vkGroupId,
      postId,
      replyToCommentId: commentId,
      message: replyText
    });

    saveBotReply({
      commentId,
      replyCommentId: result.comment_id ?? null,
      replyText
    });
  } catch (error) {
    logger.error(`Failed to reply to comment ${commentId} in post ${postId}:`, error.message);
  }
}

export async function publishOrRefreshSummary(postId, auctionId, { isSingleAuction = false } = {}) {
  const summaryRows = isSingleAuction
    ? filterSingleAuctionSummaryRows(getCurrentSummary(auctionId))
    : getCurrentSummary(auctionId);
  const summaryText = buildSummaryText(summaryRows);
  const existingSummary = getAuctionSummaryRecord(auctionId);

  logger.info(`Trying to publish summary for post ${postId}`);
  logger.info(summaryText);

  if (config.dryRun) {
    logger.info(`[DRY_RUN] Summary for post ${postId}:\n${summaryText}`);
    return;
  }

  let newCommentId = null;

  try {
    await sleep(config.replyDelayMs);

    const result = await createComment({
      groupId: config.vkGroupId,
      postId,
      message: summaryText
    });

    newCommentId = result.comment_id ?? null;
    logger.info(`Summary published for post ${postId}:`, result);
  } catch (error) {
    logger.error(`Failed to publish summary in post ${postId}:`, error.message);
    return;
  }

  saveAuctionSummaryRecord({
    auctionId,
    summaryCommentId: newCommentId,
    summaryText
  });

  if (existingSummary?.summary_comment_id) {
    try {
      await sleep(config.replyDelayMs);

      await deleteComment({
        groupId: config.vkGroupId,
        commentId: existingSummary.summary_comment_id
      });

      logger.info(
        `Deleted previous summary ${existingSummary.summary_comment_id} in post ${postId}`
      );
    } catch (error) {
      logger.warn(
        `Failed to delete previous summary ${existingSummary.summary_comment_id} in post ${postId}:`,
        error.message
      );
    }
  }
}

export async function processAuctionComments({
  postId,
  postDate,
  comments,
  isSingleAuction = false
}) {
  const postDateIso = postDate ? new Date(postDate * 1000).toISOString() : null;
  const nowIso = new Date().toISOString();

  const auction = getOrCreateAuction(
    config.vkGroupId,
    postId,
    postDateIso,
    nowIso
  );

  let shouldRefreshSummary = false;
  const newComments = comments.filter((comment) => !isCommentProcessed(comment.id));

  const userIds = [...new Set(newComments.map((c) => c.from_id).filter((id) => id > 0))];
  const userMap = await getCachedUserInfo(userIds);

  for (const comment of newComments) {
    if (!comment.text || !comment.text.trim()) {
      saveProcessedComment({
        commentId: comment.id,
        parentId: comment.parents_stack?.[0] ?? null,
        fromId: comment.from_id,
        text: comment.text || '',
        parseStatus: 'empty',
        rawResultJson: null
      });
      continue;
    }

    if (comment.from_id < 0) {
      saveProcessedComment({
        commentId: comment.id,
        parentId: comment.parents_stack?.[0] ?? null,
        fromId: comment.from_id,
        text: comment.text,
        parseStatus: 'community_comment',
        rawResultJson: null
      });
      continue;
    }

    const commentDateIso = comment.date
      ? new Date(comment.date * 1000).toISOString()
      : null;

    const isHistoricalComment =
      !!auction.armed_at &&
      !!commentDateIso &&
      new Date(commentDateIso) <= new Date(auction.armed_at);

    const suppressNotifications = isHistoricalComment;
    const suppressSideEffects = isHistoricalComment;

    const mainParseResult = parseCommentText(comment.text);
    let parseResult = mainParseResult;

    if (!parseResult.bids.length && isSingleAuction) {
      parseResult = parseSingleAuctionBidAmount(comment.text) || parseResult;
    }

    if (
      (parseResult.status === 'invalid' || parseResult.status === 'partial') &&
      config.useLmStudio
    ) {
      try {
        const lmResult = await parseCommentWithLmStudio(comment.text);
        if (lmResult.status === 'valid' && lmResult.bids.length) {
          parseResult = {
            status: 'valid',
            bids: lmResult.bids,
            failedLines: [],
            reason: lmResult.note || 'lmstudio'
          };
        }
      } catch (error) {
        logger.warn('LM Studio parse failed:', error.message);
      }
    }

    const userName = resolveUserName(comment, userMap);

    if (isSingleAuction) {
      logSingleAuctionDebug({
        comment,
        isSingleAuction,
        mainParseResult,
        parseResult
      });
    }

    if (isSingleAuction && !isSingleAuctionLotSelectionValid(parseResult)) {
      saveProcessedComment({
        commentId: comment.id,
        parentId: comment.parents_stack?.[0] ?? null,
        fromId: comment.from_id,
        text: comment.text,
        parseStatus: 'invalid',
        rawResultJson: JSON.stringify({
          parseResult,
          reason: 'single_auction_invalid_lot'
        })
      });

      logger.info(
        `Rejected single-auction bid in post ${postId}, comment ${comment.id}: only lot 1 is allowed`
      );

      if (config.autoReply && !suppressNotifications) {
        await safeReply({
          postId,
          commentId: comment.id,
          replyText: buildInvalidSingleAuctionLotReply({
            userId: comment.from_id,
            userName
          })
        });
      }

      continue;
    }

    if (!parseResult.bids.length) {
      saveProcessedComment({
        commentId: comment.id,
        parentId: comment.parents_stack?.[0] ?? null,
        fromId: comment.from_id,
        text: comment.text,
        parseStatus: parseResult.status,
        rawResultJson: JSON.stringify(parseResult)
      });

      if (
        config.autoReply &&
        !suppressNotifications &&
        parseResult.status === 'invalid' &&
        looksLikeBid(comment.text)
      ) {
        await safeReply({
          postId,
          commentId: comment.id,
          replyText: buildInvalidBidReply({
            userId: comment.from_id,
            userName
          })
        });
      }

      continue;
    }

    const tx = db.transaction((bids) => {
      const results = [];
      const notifications = [];

      for (const bid of bids) {
        const currentState = getLotState(auction.id, bid.lot);
        const previousBid = currentState?.bid_id ? getBidById(currentState.bid_id) : null;

        const effectiveState = suppressSideEffects && currentState
          ? {
              ...currentState,
              is_closed: 0,
              ends_at: null
            }
          : currentState;

        const decision = evaluateBid({
          currentState: effectiveState,
          amount: bid.amount
        });

        const savedBid = saveBid({
          auctionId: auction.id,
          commentId: comment.id,
          lotNumber: bid.lot,
          userId: comment.from_id,
          userName,
          amount: bid.amount,
          status: decision.accepted ? 'accepted' : 'rejected',
          reason: decision.reason
        });

        if (decision.accepted) {
          let endsAt = null;

          if (
            !suppressSideEffects &&
            isInExtensionPhase(auction.post_date, commentDateIso)
          ) {
            endsAt = new Date(
              new Date(commentDateIso).getTime() + 20 * 60 * 1000
            ).toISOString();
          }

          updateLotState({
            auctionId: auction.id,
            lotNumber: bid.lot,
            currentPrice: bid.amount,
            leaderUserId: comment.from_id,
            leaderName: userName,
            bidId: savedBid.id,
            endsAt,
            isClosed: 0
          });

          if (
            !suppressNotifications &&
            effectiveState &&
            previousBid &&
            effectiveState.leader_user_id !== comment.from_id
          ) {
            notifications.push({
              type: 'outbid',
              targetCommentId: previousBid.comment_id,
              targetUserId: previousBid.user_id,
              targetUserName: previousBid.user_name,
              lot: bid.lot,
              newAmount: bid.amount,
              endsAt
            });
          }
        } else {
          if (!suppressNotifications) {
            notifications.push({
              type: 'rejected',
              reason: decision.reason,
              targetCommentId: comment.id,
              targetUserId: comment.from_id,
              targetUserName: userName,
              lot: bid.lot,
              currentAmount: effectiveState?.current_price ?? 0
            });
          }
        }

        results.push({
          lot: bid.lot,
          amount: bid.amount,
          accepted: decision.accepted,
          reason: decision.reason
        });
      }

      saveProcessedComment({
        commentId: comment.id,
        parentId: comment.parents_stack?.[0] ?? null,
        fromId: comment.from_id,
        text: comment.text,
        parseStatus: parseResult.status,
        rawResultJson: JSON.stringify({ parseResult, results, notifications })
      });

      return { results, notifications };
    });

    const { results, notifications } = tx(parseResult.bids);
    logger.info(`Processed post ${postId}, comment ${comment.id} by ${userName}:`, results);

    if (!suppressSideEffects && results.some((r) => r.accepted)) {
      shouldRefreshSummary = true;
    }

    if (config.autoReply && !suppressNotifications) {
      for (const notification of notifications) {
        if (notification.type === 'outbid') {
          await safeReply({
            postId,
            commentId: notification.targetCommentId,
            replyText: buildOutbidReply({
              userId: notification.targetUserId,
              userName: notification.targetUserName,
              lot: notification.lot,
              newAmount: notification.newAmount,
              endsAt: notification.endsAt
            })
          });
        }

        if (notification.type === 'rejected') {
          let replyText;

          if (notification.reason === 'lot_closed') {
            replyText = buildClosedLotReply({
              userId: notification.targetUserId,
              userName: notification.targetUserName,
              lot: notification.lot
            });
          } else {
            replyText = buildRejectedReply({
              userId: notification.targetUserId,
              userName: notification.targetUserName,
              lot: notification.lot,
              currentAmount: notification.currentAmount
            });
          }

          await safeReply({
            postId,
            commentId: notification.targetCommentId,
            replyText
          });
        }
      }
    }
  }

  if (shouldRefreshSummary) {
    await publishOrRefreshSummary(postId, auction.id, { isSingleAuction });
  }

  return { shouldRefreshSummary };
}

export function printCurrentSummary(postId, postDate = null, { isSingleAuction = false } = {}) {
  const postDateIso = postDate ? new Date(postDate * 1000).toISOString() : null;
  const auction = getOrCreateAuction(config.vkGroupId, postId, postDateIso, null);
  const summary = isSingleAuction
    ? filterSingleAuctionSummaryRows(getCurrentSummary(auction.id))
    : getCurrentSummary(auction.id);

  if (!summary.length) {
    logger.info(`No current bids yet for post ${postId}.`);
    return;
  }

  logger.info(`Current lot summary for post ${postId}:`);
  for (const row of summary) {
    logger.info(
      `Lot ${row.lot_number}: ${row.current_price} — ${row.leader_name || row.leader_user_id}`
    );
  }
}

// Временно выключено, пока не будет полностью добита логика завершения по времени
export async function finalizeExpiredLots({ singleAuctionPostIds = new Set() } = {}) {
  const nowIso = new Date().toISOString();
  const expiredLots = getExpiredOpenLots(nowIso);

  if (!expiredLots.length) {
    return;
  }

  for (const lot of expiredLots) {
    if (singleAuctionPostIds.has(lot.post_id) && lot.lot_number !== 1) {
      logger.info(
        `Skip finalize for single-auction post ${lot.post_id}, lot ${lot.lot_number}: only lot 1 is visible`
      );
      continue;
    }

    // Перечитываем актуальное состояние лота прямо перед закрытием
    const currentState = getLotState(lot.auction_id, lot.lot_number);

    if (!currentState || currentState.is_closed) {
      continue;
    }

    // Если за время между выборкой и сейчас что-то поменялось — пропускаем
    if (currentState.bid_id !== lot.bid_id) {
      logger.info(
        `Skip finalize for lot ${lot.lot_number} in post ${lot.post_id}: bid changed`
      );
      continue;
    }

    closeLot({
      auctionId: lot.auction_id,
      lotNumber: lot.lot_number
    });

    logger.info(`Closed lot ${lot.lot_number} in post ${lot.post_id}`);

    if (config.autoReply && !lot.winner_notified) {
      const winningBid = getBidById(currentState.bid_id);

      if (winningBid) {
        markWinnerNotified({
          auctionId: lot.auction_id,
          lotNumber: lot.lot_number
        });

        await safeReply({
          postId: lot.post_id,
          commentId: winningBid.comment_id,
          replyText: buildWinnerReply({
            lot: lot.lot_number
          })
        });
      }
    }

    await publishOrRefreshSummary(lot.post_id, lot.auction_id, {
      isSingleAuction: singleAuctionPostIds.has(lot.post_id)
    });
  }
}

function buildWinnerReply({ lot }) {
  return `Поздравляем! Лот ${lot} ваш 🎉
Просим написать в @dreamdream в личные сообщения.`;
}
