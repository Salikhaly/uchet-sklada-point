import { Redis } from '@upstash/redis';

// Redis (Upstash) для быстрого состояния бота: черновик накладной, кэш
// разрешений и каталога. Источники доступа по порядку:
//  1) KV_REST_API_URL/TOKEN или UPSTASH_REDIS_REST_URL/TOKEN;
//  2) REDIS_URL (rediss://default:ПАРОЛЬ@хост.upstash.io:6379) — у Upstash пароль
//     равен REST-токену, а REST-адрес это https://<тот же хост>.
// Если ничего нет — redis = null, и бот работает через Supabase.
function resolve(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };

  const raw = process.env.REDIS_URL || process.env.KV_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname.endsWith('.upstash.io') || !u.password) return null;
    return { url: `https://${u.hostname}`, token: decodeURIComponent(u.password) };
  } catch {
    return null;
  }
}

const creds = resolve();
export const redis: Redis | null = creds ? new Redis(creds) : null;

console.log('BOT_STORE', redis ? 'redis' : 'supabase-fallback');
