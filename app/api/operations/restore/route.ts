import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
export async function POST(req: Request){
  const supabase=await createClient(); const body=await req.json();
  const {error}=await supabase.rpc('restore_operation',{p_operation_id:body.operationId});
  if(error)return NextResponse.json({error:error.message},{status:400});
  return NextResponse.json({ok:true});
}
