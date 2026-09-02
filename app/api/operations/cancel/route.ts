import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
export async function POST(req: Request){
  const supabase=await createClient(); const body=await req.json();
  const {error}=await supabase.rpc('cancel_operation',{p_operation_id:body.operationId,p_reason:body.reason??null});
  if(error)return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json({ok:true});
}
