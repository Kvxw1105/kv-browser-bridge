param(
  [string]$ChromePath = '',
  [string]$ExtensionPath = ''
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$root = Join-Path $repo 'local\e2e-managed-multi-identity'
$appData = Join-Path $root 'appdata'
$logPath = Join-Path $root 'e2e-run.log'
$reportPath = Join-Path $root 'acceptance-report.json'
$runner = Join-Path $repo 'scripts\run-managed-multi-identity-e2e.mjs'

New-Item -ItemType Directory -Force -Path $root, $appData | Out-Null
if (-not (Test-Path -LiteralPath $runner)) { throw "Managed E2E runner not found: $runner" }
if (-not $ChromePath) { $ChromePath = Join-Path ${env:PROGRAMFILES} 'Google\Chrome\Application\chrome.exe' }
if (-not (Test-Path -LiteralPath $ChromePath)) { throw "Chrome executable not found: $ChromePath" }
if (-not $ExtensionPath) { $ExtensionPath = Join-Path $repo 'apps\extension\dist' }
if (-not (Test-Path -LiteralPath (Join-Path $ExtensionPath 'manifest.json'))) { throw "Built extension not found: $ExtensionPath" }

# Keep runtime, profiles, Native Messaging discovery, and evidence under the
# ignored acceptance directory so an existing local Chrome state is untouched.
# The runner applies LOCALAPPDATA after refreshing the Native Host install;
# installation itself must inspect the user's existing Kv-owned registry state.
$env:MANAGED_E2E_ROOT = $root
$env:MANAGED_E2E_LOCALAPPDATA = $appData

& node $runner $ChromePath $ExtensionPath *> $logPath
$code = $LASTEXITCODE
if (Test-Path -LiteralPath $reportPath) { Get-Content -Raw -LiteralPath $reportPath }
Write-Host "MANAGED_MULTI_IDENTITY_E2E_EXIT_CODE=$code"
if ($code -ne 0) {
  Get-Content -Tail 120 -LiteralPath $logPath
  exit $code
}
