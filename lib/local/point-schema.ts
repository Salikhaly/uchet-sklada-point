import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

function assertLocalConnection(url: string) {
  const normalized = url.trim();
  let host = '';
  try {
    const httpUrl = normalized.replace(/^postgresql?:\/\//i, 'http://');
    host = new URL(httpUrl).hostname;
  } catch {
    throw new Error('Некорректный SUPABASE_LOCAL_DB_URL');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('LOCAL_ONLY_MODE запрещает менять удалённую БД');
  }
}

export async function ensureLocalPointSchema(): Promise<void> {
  if (!/^(1|true|yes|on)$/i.test(process.env.LOCAL_ONLY_MODE || '')) return;

  const url = process.env.SUPABASE_LOCAL_DB_URL || process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  assertLocalConnection(url);

  const file = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608310017_local_point_workspace_repair.sql'
  );
  const sql = fs.readFileSync(file, 'utf8');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3500 });
  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end().catch(() => undefined);
  }
}
