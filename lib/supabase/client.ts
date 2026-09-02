import { createBrowserClient } from '@supabase/ssr';
let client:any;
export function createClient(){
  if(client) return client;
  client=createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
  });
  return client;
}
