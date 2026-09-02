import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
export async function POST(req: Request) {
  const supabase = await createClient(); const body = await req.json();
  const { data, error } = await supabase.rpc('upsert_product', { p_name: body.name, p_price: body.price, p_status: body.status ?? 'ACTIVE' });
  if (error) return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json(data);
}
