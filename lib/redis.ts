import IORedis from 'ioredis';

// Redis (Vercel Marketplace → «Redis», регион iad1) для быстрого состояния бота:
// черновик накладной, кэш разрешений и каталога. Подключение — по REDIS_URL.
// Если переменной нет или Redis не отвечает, бот прозрачно работает через Supabase.
const url = process.env.REDIS_URL || process.env.KV_URL;

let client: IORedis | null = null;
if (url) {
  client = new IORedis(url, {
    connectTimeout: 3000,
    commandTimeout: 1500,      // не ждём «зависший» Redis дольше 1.5 с — дальше откат на Supabase
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
  });
  let lastLog = 0;
  client.on('error', (e) => {
    if (Date.now() - lastLog > 10_000) { lastLog = Date.now(); console.error('REDIS_CLIENT_ERROR', e?.message); }
  });
}

// Тонкая обёртка: значения хранятся как JSON, интерфейс как у привычного KV-клиента.
export const redis = client
  ? {
      async get<T = unknown>(key: string): Promise<T | null> {
        const v = await client!.get(key);
        return v === null ? null : (JSON.parse(v) as T);
      },
      async set(key: string, value: unknown, opts?: { ex?: number }) {
        const s = JSON.stringify(value);
        return opts?.ex ? client!.set(key, s, 'EX', opts.ex) : client!.set(key, s);
      },
      async del(key: string) { return client!.del(key); },
      async ping() { return client!.ping(); },
    }
  : null;

console.log('BOT_STORE', redis ? 'redis' : 'supabase-fallback');
