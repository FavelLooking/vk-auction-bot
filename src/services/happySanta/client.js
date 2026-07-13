import axios from 'axios';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

function isConfigured() {
  return Boolean(config.happySantaApiBaseUrl && config.happySantaApiToken);
}

function buildUrl(path) {
  const baseUrl = config.happySantaApiBaseUrl.replace(/\/+$/, '');
  const url = new URL(`${baseUrl}/${path.replace(/^\/+/, '')}`);
  url.searchParams.set('token', config.happySantaApiToken);

  return url.toString();
}

function assertValidResponse(response, action) {
  if (!response || typeof response.data !== 'object') {
    throw new Error(`Happy Santa ${action} returned invalid response`);
  }

  if (response.data.error || response.data.errors) {
    throw new Error(`Happy Santa ${action} API error: ${JSON.stringify(response.data)}`);
  }

  return response.data;
}

export function createHappySantaClient() {
  const http = axios.create({
    timeout: config.happySantaTimeoutMs,
    headers: {
      'Content-Type': 'application/json'
    }
  });

  async function request(action, method, path, body = undefined) {
    if (!isConfigured()) {
      throw new Error('Happy Santa API is not configured');
    }

    try {
      const response = await http.request({
        method,
        url: buildUrl(path),
        data: body
      });

      return assertValidResponse(response, action);
    } catch (error) {
      if (error.response) {
        logger.error(
          `Happy Santa ${action} failed with HTTP ${error.response.status}:`,
          JSON.stringify(error.response.data)
        );
      } else {
        logger.error(`Happy Santa ${action} failed:`, error.message);
      }

      throw error;
    }
  }

  async function sendBroadcast(message, listIds, options = {}) {
    const payload = {
      list_ids: listIds,
      run_now: 1
    };
    const messagePayload = {
      message
    };

    if (options.attachments?.length) {
      messagePayload.attachment = options.attachments.join(',');
    }

    payload.message = messagePayload;

    logger.info(`Happy Santa request body: ${JSON.stringify(payload)}`);

    return request('broadcast create', 'post', '/broadcast', payload);
  }

  async function getLists() {
    return request('lists fetch', 'get', '/lists');
  }

  return {
    sendBroadcast,
    getLists
  };
}
