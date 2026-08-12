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
}

Write-Host "[2/4] Running local diagnostics..."
$doctorOutput = node apps/codex-mcp-server/dist/computer-doctor.js --json
if ($LASTEXITCODE -ne 0) {
  Write-Host $doctorOutput
  throw "Computer Use diagnostics reported a required failure."
}

$report = $doctorOutput | ConvertFrom-Json
$failedRequired = @($report.checks | Where-Object { $_.required -and -not $_.ok })
if ($failedRequired.Count -gt 0) {
  $failedNames = ($failedRequired | ForEach-Object { $_.name }) -join ", "
  throw "Required diagnostic checks failed: $failedNames"
}

if ($ReportPath) {
  $resolvedReport = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $ReportPath))
  $reportDirectory = Split-Path -Parent $resolvedReport
  New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  $doctorOutput | Set-Content -Path $resolvedReport -Encoding UTF8
  Write-Host "Diagnostic report: $resolvedReport"
}

Write-Host "[3/4] Checking Codex integration status..."
$codexStatusOutput = node apps/codex-mcp-server/dist/codex-install.js status
if ($LASTEXITCODE -ne 0) { throw "Could not inspect Codex MCP configuration." }
$codexStatus = $codexStatusOutput | ConvertFrom-Json

if ($InstallCodex -and -not $codexStatus.installed) {
  Write-Host "Installing managed Codex MCP configuration..."
  $installOutput = node apps/codex-mcp-server/dist/codex-install.js install
  if ($LASTEXITCODE -ne 0) { throw "Codex MCP installation failed." }
  $codexStatus = $installOutput | ConvertFrom-Json
}

Write-Host "[4/4] Smoke-test summary"
Write-Host "Runtime diagnostics: PASS"
Write-Host "Windows UIA: $((@($report.checks | Where-Object { $_.name -eq 'windows-uia-sidecar' })[0]).ok)"
Write-Host "Chrome Bridge: $((@($report.checks | Where-Object { $_.name -eq 'chrome-bridge' })[0]).ok)"
Write-Host "Codex MCP installed: $($codexStatus.installed)"
Write-Host "Codex config: $($codexStatus.configPath)"

if (-not $codexStatus.installed) {
  Write-Host "No configuration was changed. Re-run with -InstallCodex to install the managed MCP block."
}
