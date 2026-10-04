import { NextResponse } from 'next/server';
import { setWebhook } from '@/lib/telegram/client';

// Одноразовая настройка: регистрирует вебхук бота в Telegram.
// Открывается один раз вручную в браузере: /api/telegram/setup?secret=...
// secret должен совпадать с TELEGRAM_SETUP_SECRET (чтобы случайный человек
// не мог перехватить вебхук, указав свой URL).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.TELEGRAM_SETUP_SECRET || secret !== process.env.TELEGRAM_SETUP_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 401 });
  }
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!webhookSecret || !siteUrl) {
    return NextResponse.json({ error: 'TELEGRAM_WEBHOOK_SECRET или NEXT_PUBLIC_SITE_URL не заданы' }, { status: 500 });
  }
  const webhookUrl = `${siteUrl.replace(/\/$/, '')}/api/telegram/webhook`;
  const result = await setWebhook(webhookUrl, webhookSecret);
  return NextResponse.json({ webhookUrl, result });
}
