# First-run local login fix

- First login no longer requires a pre-created warehouse profile.
- Login API automatically creates `ansar@warehouse.local` (or `WAREHOUSE_LOGIN_EMAIL`) when the configured user does not exist.
- The entered password becomes the local account password (minimum 6 characters).
- The auth trigger creates the initial workspace/profile; the server also repairs a missing profile if an existing auth user has no profile.
- Login UI explains the first-run flow.
- Existing users are never duplicated.

Required server environment variable:
`SUPABASE_SECRET_KEY` must contain the server-only Supabase secret/service-role key.
