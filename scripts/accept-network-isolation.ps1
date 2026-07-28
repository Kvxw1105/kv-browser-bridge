param(
  [Parameter(Mandatory = $true)]
  [string[]]$Manifest,
  [switch]$SkipInstall,
  [switch]$StopAfter
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Step {
  param([string]$Name, [scriptblock]$Action)
  Write-Host "`n==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$startedManifests = @()
Push-Location $repoRoot
try {
  if (-not $SkipInstall) {
    Invoke-Step 'Install dependencies' { npm ci }
  }
  Invoke-Step 'Build local Chrome runtime' { npm run build:local-chrome }
  Invoke-Step 'Run local Chrome tests' { npm run test:local-chrome }
  Invoke-Step 'Run local Chrome type checks' { npm run check:local-chrome }

  $cli = Join-Path $repoRoot 'apps/chrome-bridge/dist/identity-cli.js'
  $results = @()

  foreach ($manifestPath in $Manifest) {
    $resolved = Resolve-Path $manifestPath
    Invoke-Step "Validate manifest $resolved" { node $cli check $resolved }
    Invoke-Step "Check proxy $resolved" { node $cli proxy-check $resolved }
    Invoke-Step "Start and verify public egress $resolved" { node $cli start $resolved }
    $startedManifests += $resolved.Path
    Invoke-Step "Verify DNS, WebRTC, and IPv6 $resolved" { node $cli network-leak-check $resolved }
    Invoke-Step "Run identity doctor $resolved" { node $cli doctor $resolved }

    $networkEnvelope = (node $cli network-status $resolved | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "network-status failed for $resolved" }
    if ($networkEnvelope.state -ne 'verified' -or $null -eq $networkEnvelope.network) {
      throw "Identity $($networkEnvelope.identityId) is not verified. State: $($networkEnvelope.state)"
    }
    $network = $networkEnvelope.network
    $leakPath = Join-Path (Split-Path $networkEnvelope.network.probeUrl -Parent) ''
    $runtimeRoot = if ($env:KV_IDENTITY_RUNTIME_DIR) { $env:KV_IDENTITY_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA 'KvBrowserBridge\identities' }
    $leakReportPath = Join-Path $runtimeRoot "$($networkEnvelope.identityId)\network\network-leak-acceptance.json"
    if (-not (Test-Path $leakReportPath)) { throw "Leak acceptance report missing for $($networkEnvelope.identityId): $leakReportPath" }
    $leak = Get-Content -Raw $leakReportPath | ConvertFrom-Json
    if ($leak.ready -ne $true) { throw "Leak acceptance is not ready for $($networkEnvelope.identityId): $($leak.blockedReasons -join ', ')" }

    $results += [pscustomobject]@{
      Manifest = $resolved.Path
      IdentityId = $networkEnvelope.identityId
      PublicIp = $network.publicIp
      BaselinePublicIp = $network.baselinePublicIp
      RuntimeSessionId = $network.runtimeSessionId
      ObservedAt = $network.observedAt
      State = $network.state
      DnsStatus = $leak.dns.status
      WebRtcStatus = $leak.webrtc.status
      Ipv6Status = $leak.ipv6.status
      LeakReportPath = $leakReportPath
    }
  }

  $duplicates = $results | Group-Object PublicIp | Where-Object Count -gt 1
  if ($duplicates) {
    $details = $duplicates | ForEach-Object { "$($_.Name): $((($_.Group).IdentityId) -join ', ')" }
    throw "Public IP collision detected after acceptance: $($details -join '; ')"
  }

  $reportPath = Join-Path $repoRoot 'network-isolation-acceptance.json'
  $report = [pscustomobject]@{
    schemaVersion = 2
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    host = $env:COMPUTERNAME
    identities = $results
    uniquePublicIps = $true
    leakAcceptancePassed = $true
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $reportPath
  Write-Host "`nAcceptance passed. Report: $reportPath"
} finally {
  if ($StopAfter -or $Error.Count -gt 0) {
    foreach ($manifestPath in $startedManifests) {
      try { node $cli stop $manifestPath | Out-Host } catch { Write-Warning "Could not stop identity $manifestPath: $_" }
    }
  }
  Pop-Location
}
