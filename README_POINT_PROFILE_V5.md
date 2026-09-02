# Point profile / state fixes v5

- New auth users no longer receive an extra Point workspace from the auth trigger; login binding owns Point provisioning.
- Existing Point workspaces are resynchronized with Angar products/contractors on login.
- Point journal no longer hides ARRIVAL operations whose contractor is null.
- Added native `verify:profile:native` script without `@supabase/supabase-js`.

Live verification from the model runtime may still be blocked by outbound DNS/network policy; run the native script in the deployment environment.
