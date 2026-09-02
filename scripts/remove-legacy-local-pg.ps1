$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$refs = Get-ChildItem -Path $root -Recurse -File -Include *.ts,*.tsx,*.js,*.mjs -ErrorAction SilentlyContinue |
  Select-String -Pattern 'app-mode|point-schema|ensureLocalPointSchema' -SimpleMatch |
  Where-Object { $_.Path -notmatch '\\node_modules\\|\\.next\\' }

if ($refs) {
  Write-Host 'References to the legacy local PostgreSQL layer were found:' -ForegroundColor Yellow
  $refs | ForEach-Object { Write-Host ("{0}:{1}" -f $_.Path,$_.LineNumber) }
  Write-Host 'Review the references before deleting the files.' -ForegroundColor Yellow
  exit 2
}

$targets = @(
  (Join-Path $root 'app\api\app-mode\route.ts'),
  (Join-Path $root 'lib\local\point-schema.ts')
)
foreach ($target in $targets) {
  if (Test-Path $target) {
    Remove-Item -Force $target
    Write-Host "Removed $target"
  }
}
