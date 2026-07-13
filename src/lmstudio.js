import axios from 'axios';
import { config } from './config.js';

const client = axios.create({
  baseURL: config.lmStudioBaseUrl,
  timeout: 30000
});

function extractJson(text) {
  const match = String(text || '').match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function parseCommentWithLmStudio(text) {
  const prompt = `
Извлеки ставки из комментария аукциона.
Верни только JSON.

Формат ответа:
{
  "status": "valid" | "ambiguous" | "invalid",
  "bids": [
    { "lot": 1, "amount": 300 }
  ],
  "note": "short reason"
}

Правила:
- Если номера лотов неясны, статус ambiguous.
- Если это не ставка, статус invalid.
- Не выдумывай данные.
- lot и amount только числа.

Комментарий:
"""
${text}
"""
`;

const response = await client.post('/chat/completions', {
    model: config.lmStudioModel,
    temperature: 0,
    messages: [
      { role: 'system', content: 'Ты извлекаешь структурированные данные из комментариев аукциона.' },
      { role: 'user', content: prompt }
    ]
  });

  const content = response?.data?.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content);

  if (!parsed || typeof parsed !== 'object') {
    return {
      status: 'invalid',
      bids: [],
      note: 'lmstudio_invalid_json'
    };
  }

  const bids = Array.isArray(parsed.bids)
    ? parsed.bids
        .map((b) => ({
          lot: Number(b.lot),
          amount: Number(b.amount),
          confidence: 'lmstudio'
        }))
        .filter((b) => Number.isInteger(b.lot) && Number.isInteger(b.amount))
    : [];

  return {
    status: parsed.status || (bids.length ? 'valid' : 'invalid'),
    bids,
    note: parsed.note || null
  };
}