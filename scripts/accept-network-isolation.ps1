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
    Invoke-Step "Start and verify network $resolved" { node $cli start $resolved }
    Invoke-Step "Read network status $resolved" { node $cli network-status $resolved }
    Invoke-Step "Run identity doctor $resolved" { node $cli doctor $resolved }

    $networkJson = node $cli network-status $resolved | Out-String
    if ($LASTEXITCODE -ne 0) { throw "network-status failed for $resolved" }
    $network = $networkJson | ConvertFrom-Json
    if ($network.state -ne 'verified') {
      throw "Identity $($network.identityId) is not verified. State: $($network.state)"
    }

    $results += [pscustomobject]@{
      Manifest = $resolved.Path
      IdentityId = $network.identityId
      PublicIp = $network.publicIp
      BaselinePublicIp = $network.baselinePublicIp
      RuntimeSessionId = $network.runtimeSessionId
      ObservedAt = $network.observedAt
      State = $network.state
    }
  }

  $duplicates = $results | Group-Object PublicIp | Where-Object Count -gt 1
  if ($duplicates) {
    $details = $duplicates | ForEach-Object { "$($_.Name): $((($_.Group).IdentityId) -join ', ')" }
    throw "Public IP collision detected after acceptance: $($details -join '; ')"
  }

  $reportPath = Join-Path $repoRoot 'network-isolation-acceptance.json'
  $report = [pscustomobject]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    host = $env:COMPUTERNAME
    identities = $results
    uniquePublicIps = $true
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $reportPath
  Write-Host "`nAcceptance passed. Report: $reportPath"

  if ($StopAfter) {
    foreach ($manifestPath in $Manifest) {
      $resolved = Resolve-Path $manifestPath
      Invoke-Step "Stop identity $resolved" { node $cli stop $resolved }
    }
  }
} finally {
  Pop-Location
}
