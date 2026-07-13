import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { createHappySantaClient } from '../happySanta/client.js';

const happySantaClient = createHappySantaClient();

function getTarget() {
  if (!config.happySantaApiToken) {
    logger.warn('Happy Santa API token is not configured.');
    return null;
  }

  if (!config.happySantaAuctionListId) {
    logger.warn('Happy Santa mailing list is not configured.');
    return null;
  }

  return {
    listIds: [config.happySantaAuctionListId]
  };
}

export async function sendHappySantaReminder({ message, attachments = [] }) {
  const target = getTarget();
  if (!target) {
    return {
      sent: false,
      reason: 'not_configured'
    };
  }

  try {
    const response = await happySantaClient.sendBroadcast(message, target.listIds, {
      attachments
    });

    logger.info('Happy Santa reminder broadcast sent.');

    return {
      sent: true,
      listIds: target.listIds,
      response
    };
  } catch (error) {
    logger.error('Happy Santa reminder broadcast failed:', error.message);
    return {
      sent: false,
      error
    };
  }
}
