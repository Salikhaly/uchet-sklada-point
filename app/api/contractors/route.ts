import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
export async function POST(req: Request) {
  const supabase = await createClient(); const body = await req.json();
  const { data, error } = await supabase.rpc('upsert_contractor', { p_name: body.name, p_group_id: body.groupId ?? null });
  if (error) return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json(data);
}
