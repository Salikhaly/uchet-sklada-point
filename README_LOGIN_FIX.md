# Login/profile fix

The previous build authenticated successfully but then redirected from `/` back to `/login?error=Нет профиля склада или Точки` because the Auth user had no matching row in `public.profiles` (or no Point workspace).

This build provisions the profile immediately after a successful password login. It uses the server-only Supabase service key and `SUPABASE_WORKSPACE_ID` for the existing Angar workspace when a profile is missing. If `point_workspace_id` is missing, a dedicated Point workspace is created and basic products/contractors are copied from Angar.

Required server environment variables:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_WORKSPACE_ID`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `WAREHOUSE_LOGIN_USERNAME`
- `WAREHOUSE_LOGIN_EMAIL`

The home page no longer redirects an already-authenticated user back to `/login` when a profile is missing, so there is no redirect loop.
