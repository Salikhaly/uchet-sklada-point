import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const enabled = /^(1|true|yes|on)$/i.test(process.env.LOCAL_ONLY_MODE || '');
if (!enabled) process.exit(0);

const url = process.env.SUPABASE_LOCAL_DB_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const sqlFile = path.join(process.cwd(), 'supabase', 'migrations', '202608310017_local_point_workspace_repair.sql');
const sql = fs.readFileSync(sqlFile, 'utf8');

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2500 });
try {
  await client.connect();
  await client.query(sql);
  console.log('[local] Point/Angar schema repair applied. Production is not touched.');
} catch (err) {
  const msg = String(err?.message || err);
  console.warn(`[local] Schema bootstrap skipped: ${msg}`);
  console.warn('[local] Start local Supabase first, then run npm run dev again.');
} finally {
  await client.end().catch(() => {});
}
