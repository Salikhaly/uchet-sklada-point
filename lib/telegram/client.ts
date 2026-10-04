// Тонкая обёртка над Telegram Bot API. Используется только серверным вебхуком
// (app/api/telegram/webhook) — токен бота никогда не попадает в клиентский код.

function botToken() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  return t;
}

async function call(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    console.error('TELEGRAM_API_ERROR', method, data);
  }
  return data;
}

export type InlineButton = { text: string; callback_data: string };

export function sendMessage(chatId: number, text: string, buttons?: InlineButton[][]) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
  });
}

export function answerCallbackQuery(id: string, text?: string) {
  return call('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
}

export function setWebhook(url: string, secretToken: string) {
  return call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'] });
}
