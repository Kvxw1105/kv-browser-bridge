param(
  [Parameter(Mandatory = $true)][string[]]$Manifest,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repoRoot
try {
  if (-not $SkipBuild) {
    npm run build:local-chrome
    if ($LASTEXITCODE -ne 0) { throw 'build:local-chrome failed.' }
  }

  $cli = Join-Path $repoRoot 'apps/chrome-bridge/dist/identity-cli.js'
  if (-not (Test-Path $cli)) { throw "Identity CLI not found: $cli" }

  $items = @()
  foreach ($path in $Manifest) {
    $resolved = Resolve-Path $path
    $raw = Get-Content -Raw -Path $resolved | ConvertFrom-Json
    $checkJson = node $cli check $resolved | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Manifest validation failed: $resolved`n$checkJson" }
    $check = $checkJson | ConvertFrom-Json

    $items += [pscustomobject]@{
      Manifest = $resolved.Path
      IdentityId = [string]$raw.identityId
      ChromePath = [string]$raw.browser.executablePath
      UserDataDir = [string]$raw.browser.userDataDir
      ProxyHost = [string]$raw.proxy.host
      ProxyPort = [int]$raw.proxy.port
      ProxyProtocol = [string]$raw.proxy.protocol
      CountryCode = [string]$raw.proxy.countryCode
      Timezone = [string]$raw.proxy.timezone
      Locale = [string]$raw.proxy.locale
      DnsProbeUrl = [string]$raw.networkVerification.dnsProbeUrl
      ExpectedDnsCount = @($raw.networkVerification.expectedDnsResolvers).Count
      Healthy = [bool]$check.healthy
      Findings = @($check.findings)
    }
  }

  $problems = @()
  foreach ($group in ($items | Group-Object IdentityId | Where-Object Count -gt 1)) {
    $problems += "Duplicate identityId: $($group.Name)"
  }
  foreach ($group in ($items | Group-Object UserDataDir | Where-Object Count -gt 1)) {
    $problems += "Duplicate browser userDataDir: $($group.Name)"
  }
  foreach ($group in ($items | Group-Object { "$($_.ProxyProtocol)://$($_.ProxyHost):$($_.ProxyPort)" } | Where-Object Count -gt 1)) {
    $problems += "Duplicate local proxy endpoint: $($group.Name)"
  }
  foreach ($item in $items) {
    if (-not (Test-Path $item.ChromePath)) { $problems += "Chrome executable missing for $($item.IdentityId): $($item.ChromePath)" }
    if (-not $item.Healthy) { $problems += "Manifest health check failed for $($item.IdentityId)." }
    if ([string]::IsNullOrWhiteSpace($item.DnsProbeUrl)) { $problems += "DNS probe is not configured for $($item.IdentityId)." }
    if ($item.ExpectedDnsCount -eq 0) { $problems += "Expected DNS resolver list is empty for $($item.IdentityId)." }
  }

  $requiredUserInputs = @()
  if ($items.Count -eq 0) { $requiredUserInputs += 'At least one identity manifest.' }
  if ($items | Where-Object { [string]::IsNullOrWhiteSpace($_.DnsProbeUrl) }) {
    $requiredUserInputs += 'One HTTPS DNS resolver-observation endpoint, plus the expected resolver IPs for each Clash route.'
  }
  $requiredUserInputs += 'One distinct local Clash/Mihomo inbound port per identity.'
  $requiredUserInputs += 'Confirmation that every inbound maps to a distinct, stable outbound public IP.'

  $result = [ordered]@{
    ok = $problems.Count -eq 0
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    identities = $items
    problems = $problems
    requiredUserInputs = $requiredUserInputs | Select-Object -Unique
    nextCommand = if ($problems.Count -eq 0) {
      ".\scripts\accept-network-isolation.ps1 -Manifest $((($items.Manifest | ForEach-Object { "'$_'" }) -join ', ')) -StopAfter"
    } else { $null }
  }

  $result | ConvertTo-Json -Depth 8
  if (-not $result.ok) { exit 1 }
} finally {
  Pop-Location
}
