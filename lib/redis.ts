import { Redis } from '@upstash/redis';

// Redis (Upstash) для быстрого состояния бота: черновик накладной, кэш
// разрешений и каталога. Переменные подставляет интеграция Upstash из
// Vercel Marketplace (KV_REST_API_*), поддерживаем и «родные» имена Upstash.
// Если переменных нет — redis = null, и бот работает через Supabase как раньше.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis: Redis | null = url && token ? new Redis({ url, token }) : null;
