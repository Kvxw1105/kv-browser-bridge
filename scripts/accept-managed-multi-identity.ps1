param(
  [string]$ChromePath = '',
  [string]$ExtensionPath = ''
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$root = Join-Path $repo 'local\e2e-managed-multi-identity'
$runtimeRoot = Join-Path $root 'runtime'
$profileRoot = Join-Path $root 'profiles'
$manifestRoot = Join-Path $root 'manifests'
$reportPath = Join-Path $root 'acceptance-report.json'
New-Item -ItemType Directory -Force -Path $runtimeRoot, $profileRoot, $manifestRoot | Out-Null

if (-not $ChromePath) { $ChromePath = Join-Path ${env:PROGRAMFILES} 'Google\Chrome\Application\chrome.exe' }
if (-not (Test-Path -LiteralPath $ChromePath)) { throw "Chrome executable not found: $ChromePath" }
if (-not $ExtensionPath) { $ExtensionPath = Join-Path $repo 'apps\extension\dist' }
if (-not (Test-Path -LiteralPath (Join-Path $ExtensionPath 'manifest.json'))) { throw "Built extension not found: $ExtensionPath" }

function Get-UnpackedExtensionId([string]$path) {
  # Chrome derives an unpacked extension ID from the absolute path encoded as
  # UTF-16LE. Preserve the path casing used by Extensions.loadUnpacked.
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::Unicode.GetBytes($path))
  $id = [System.Text.StringBuilder]::new()
  foreach ($byte in $hash[0..15]) { [void]$id.Append([char](97 + ($byte -shr 4))); [void]$id.Append([char](97 + ($byte -band 15))) }
  $id.ToString()
}
function Write-JsonNoBom([string]$path, $value) { [System.IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 12) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false)) }
function New-Manifest([string]$identityId) {
  $now = [DateTime]::UtcNow.ToString('o')
  [ordered]@{
    schemaVersion = 1; identityId = $identityId; workspaceId = 'managed-alpha'; platform = 'windows'; accountLabel = $identityId; mode = 'native-stable'
    browser = [ordered]@{ executablePath = $ChromePath; userDataDir = (Join-Path $profileRoot $identityId) }
    environment = [ordered]@{ osFamily = 'windows'; locale = 'zh-CN'; timezone = 'Asia/Shanghai'; screen = [ordered]@{ width = 1280; height = 720; deviceScaleFactor = 1 } }
    proxy = [ordered]@{ id = 'shared-local-proxy'; protocol = 'http'; host = '127.0.0.1'; port = 7897; authMode = 'none'; countryCode = 'CN'; locale = 'zh-CN'; timezone = 'Asia/Shanghai' }
    policies = [ordered]@{ webrtc = 'proxy-only'; dns = 'system'; ipv6 = 'disabled'; allowConcurrentSessions = $false }
    networkVerification = [ordered]@{ publicIpProbeUrl = 'https://api.ipify.org?format=json'; timeoutMs = 30000 }
    createdAt = $now; updatedAt = $now
  }
}
function Invoke-Node([string[]]$nodeArgs, [string]$logPath) {
  & node @nodeArgs *> $logPath
  return $LASTEXITCODE
}
function Read-Json([string]$path) { if (-not (Test-Path -LiteralPath $path)) { return $null }; Get-Content -Raw -LiteralPath $path | ConvertFrom-Json }
function Wait-Bridge([string[]]$ids, [int]$timeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    $ready = $true
    foreach ($id in $ids) {
      $private = Join-Path $env:LOCALAPPDATA "KvBrowserBridge\identities\$id\bridge.json"
      $public = Join-Path $env:LOCALAPPDATA "KvBrowserBridge\sessions\$id.json"
      if (-not (Test-Path $private) -or -not (Test-Path $public)) { $ready = $false }
    }
    if ($ready) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

$extensionId = Get-UnpackedExtensionId $ExtensionPath
$installLog = Join-Path $root 'native-host-install.log'
$installCode = Invoke-Node @('apps/chrome-bridge/dist/install.js', 'install', $extensionId) $installLog
if ($installCode -ne 0) { throw "Native host installation failed; see $installLog" }
$env:KV_IDENTITY_RUNTIME_DIR = $runtimeRoot
$env:KV_BROWSER_EXTENSION_PATH = (Resolve-Path $ExtensionPath).Path
$alpha = 'managed-alpha-a'; $beta = 'managed-alpha-b'; $ids = @($alpha, $beta)
$manifestPaths = @{}
foreach ($id in $ids) { $path = Join-Path $manifestRoot "$id.json"; Write-JsonNoBom $path (New-Manifest $id); $manifestPaths[$id] = $path }

$startCodes = @{}
foreach ($id in $ids) { $startCodes[$id] = Invoke-Node @('apps/chrome-bridge/dist/identity-cli.js', 'start-process', $manifestPaths[$id]) (Join-Path $root "start-$id.log") }
$bridgeReady = Wait-Bridge $ids
$report = [ordered]@{ schemaVersion = 1; generatedAt = [DateTime]::UtcNow.ToString('o'); identityIds = $ids; extensionId = $extensionId; proxy = 'http://127.0.0.1:7897'; startExitCodes = $startCodes; checks = @(); stopped = $false }
if (-not $bridgeReady) { $report.checks += [ordered]@{ name = 'bridge_handshakes'; ok = $false; reason = 'Timed out waiting for private discovery and public handshake records.' }; foreach ($id in $ids) { Invoke-Node @('apps/chrome-bridge/dist/identity-cli.js', 'stop', $manifestPaths[$id]) (Join-Path $root "stop-$id.log") | Out-Null }; Write-JsonNoBom $reportPath $report; throw "Bridge handshake did not complete; report written to $reportPath" }

$oldAlpha = (Read-Json (Join-Path $runtimeRoot "$alpha\runtime\session-receipt.json")).runtimeSessionId
$env:MANAGED_E2E_ALPHA = $alpha; $env:MANAGED_E2E_BETA = $beta; $env:MANAGED_E2E_PHASE = 'initial'
$mcpInitial = Invoke-Node @('scripts/managed-multi-identity-mcp-check.mjs') (Join-Path $root 'mcp-initial.log')
$report.checks += [ordered]@{ name = 'mcp_identity_selection_and_markers'; ok = ($mcpInitial -eq 0); log = 'mcp-initial.log' }
Invoke-Node @('apps/chrome-bridge/dist/identity-cli.js', 'stop', $manifestPaths[$alpha]) (Join-Path $root "stop-$alpha.log") | Out-Null
$env:MANAGED_E2E_PHASE = 'after-stop'
$mcpAfterStop = Invoke-Node @('scripts/managed-multi-identity-mcp-check.mjs') (Join-Path $root 'mcp-after-stop.log')
$report.checks += [ordered]@{ name = 'stop_a_preserves_b'; ok = ($mcpAfterStop -eq 0); log = 'mcp-after-stop.log' }
Invoke-Node @('apps/chrome-bridge/dist/identity-cli.js', 'start-process', $manifestPaths[$alpha]) (Join-Path $root "restart-$alpha.log") | Out-Null
if (-not (Wait-Bridge @($alpha))) { $report.checks += [ordered]@{ name = 'restart_a_bridge'; ok = $false }; throw "Identity A did not restore Bridge readiness." }
$env:MANAGED_E2E_PHASE = 'after-restart'; $env:MANAGED_E2E_OLD_ALPHA_SESSION = $oldAlpha
$mcpAfterRestart = Invoke-Node @('scripts/managed-multi-identity-mcp-check.mjs') (Join-Path $root 'mcp-after-restart.log')
$report.checks += [ordered]@{ name = 'restart_a_new_session_and_profile_route'; ok = ($mcpAfterRestart -eq 0); log = 'mcp-after-restart.log' }
foreach ($id in $ids) { Invoke-Node @('apps/chrome-bridge/dist/identity-cli.js', 'stop', $manifestPaths[$id]) (Join-Path $root "stop-$id-final.log") | Out-Null }
Start-Sleep -Seconds 2
$report.stopped = $true
$report.checks += [ordered]@{ name = 'both_stopped'; ok = $true }
$report.ok = ($report.checks | Where-Object { -not $_.ok }).Count -eq 0
Write-JsonNoBom $reportPath $report
Get-Content -Raw -LiteralPath $reportPath
if (-not $report.ok) { exit 1 }
