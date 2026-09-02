param(
  [Parameter(Mandatory=$true)][string]$CsvPath
)
if (-not $env:SUPABASE_URL) { $env:SUPABASE_URL = Read-Host 'SUPABASE_URL' }
if (-not $env:SUPABASE_SECRET_KEY) { $env:SUPABASE_SECRET_KEY = Read-Host 'SUPABASE_SECRET_KEY' }
Write-Host 'Запускаю безопасную проверку CSV. В базу ничего не записывается.' -ForegroundColor Cyan
node .\scripts\preflight_google_journal.mjs $CsvPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
