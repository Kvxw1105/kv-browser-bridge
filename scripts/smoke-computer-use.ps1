param(
  [switch]$InstallCodex,
  [switch]$SkipBuild,
  [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SkipBuild) {
  Write-Host "[1/4] Building Computer Use runtime..."
  npm run prepare-computer-use
  if ($LASTEXITCODE -ne 0) { throw "Computer Use build failed." }
} else {
  Write-Host "[1/4] Build skipped by request."
}

Write-Host "[2/4] Running local diagnostics..."
$doctorOutput = node apps/codex-mcp-server/dist/computer-doctor.js --json
$doctorExit = $LASTEXITCODE
$doctorText = ($doctorOutput | Out-String).Trim()
if ($doctorText) { Write-Host $doctorText }
try {
  $report = $doctorText | ConvertFrom-Json
} catch {
  throw "Computer Use doctor did not return valid JSON. Exit code: $doctorExit"
}

$failedRequired = @($report.checks | Where-Object { $_.required -and -not $_.ok })
if ($doctorExit -ne 0 -or $failedRequired.Count -gt 0) {
  $failedNames = ($failedRequired | ForEach-Object { $_.name }) -join ", "
  throw "Required diagnostic checks failed: $failedNames (exit code $doctorExit)"
}

if ($ReportPath) {
  $resolvedReport = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ReportPath))
  $reportDirectory = Split-Path -Parent $resolvedReport
  New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  $doctorText | Set-Content -Path $resolvedReport -Encoding UTF8
  Write-Host "Diagnostic report: $resolvedReport"
}

if ($InstallCodex) {
  Write-Host "[3/4] Installing managed Codex configuration..."
  node apps/codex-mcp-server/dist/codex-install.js install
  if ($LASTEXITCODE -ne 0) { throw "Codex MCP installation failed." }
} else {
  Write-Host "[3/4] Codex installation unchanged."
}

Write-Host "[4/4] Reading unified Computer Use status..."
$statusOutput = node apps/codex-mcp-server/dist/computer-status.js --json
$statusExit = $LASTEXITCODE
$statusText = ($statusOutput | Out-String).Trim()
if ($statusText) { Write-Host $statusText }
try {
  $computerStatus = $statusText | ConvertFrom-Json
} catch {
  throw "Unified Computer Use status did not return valid JSON. Exit code: $statusExit"
}

Write-Host "Runtime diagnostics: PASS"
Write-Host "Unified state: $($computerStatus.state)"
Write-Host "Windows UIA: $((@($report.checks | Where-Object { $_.name -eq 'windows-uia-sidecar' })[0]).ok)"
Write-Host "Chrome Bridge: $((@($report.checks | Where-Object { $_.name -eq 'chrome-bridge' })[0]).ok)"
Write-Host "Codex MCP installed: $($computerStatus.codex.installed)"
Write-Host "Codex config: $($computerStatus.codex.configPath)"
if ($statusExit -ne 0) {
  Write-Host "Unified status returned exit code $statusExit with valid JSON; state '$($computerStatus.state)' remains authoritative."
}
foreach ($action in @($computerStatus.nextActions)) {
  Write-Host "Next: $action"
}
