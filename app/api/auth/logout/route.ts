import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

async function logoutResponse(request: Request) {
  const supabase=await createClient();
  await supabase.auth.signOut();
  const url=new URL('/login',request.url);
  return NextResponse.redirect(url);
}

export async function POST(request: Request){ return logoutResponse(request); }
export async function GET(request: Request){ return logoutResponse(request); }
