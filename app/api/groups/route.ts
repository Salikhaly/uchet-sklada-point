import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
export async function POST(req: Request) {
  const supabase = await createClient(); const body = await req.json();
  const { data, error } = await supabase.rpc('save_client_group', { p_parent_name: body.parent, p_child_name: body.child });
  if (error) return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json(data);
}
