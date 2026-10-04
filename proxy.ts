import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function proxy(request:NextRequest){
  let response=NextResponse.next({request});
  const supabase=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{
    cookies:{
      getAll(){return request.cookies.getAll();},
      setAll(cookiesToSet){cookiesToSet.forEach(({name,value,options})=>{request.cookies.set(name,value);response.cookies.set(name,value,options);});}
    }
  });
  const {data:{user}}=await supabase.auth.getUser();
  const path=request.nextUrl.pathname;
  if(!user && path!=='/login' && !path.startsWith('/api/auth/') && !path.startsWith('/api/telegram/')){
    const url=request.nextUrl.clone(); url.pathname='/login'; url.searchParams.delete('error');
    return NextResponse.redirect(url);
  }
  // Do not redirect authenticated users away from /login.
  // The home page can legitimately redirect back here with an error (e.g. missing workspace),
  // and bouncing /login -> / -> /login creates an infinite 307 loop.
  return response;
}

export const config={matcher:['/((?!_next/static|_next/image|favicon.ico|api/telegram).*)']};
