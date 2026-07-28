[CmdletBinding()]
param(
  [ValidateRange(1, 26)]
  [int]$Accounts = 2,
  [string]$LocalDir = '.\local'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedLocal = [System.IO.Path]::GetFullPath((Join-Path $root $LocalDir))
New-Item -ItemType Directory -Force -Path $resolvedLocal | Out-Null

$discoveryPath = Join-Path $resolvedLocal 'network-runtime-discovery.json'
$setupPath = Join-Path $resolvedLocal 'network-identities.setup.json'

& (Join-Path $PSScriptRoot 'discover-network-runtime.ps1') -OutputPath $discoveryPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Windows runtime discovery failed.' }

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'Node.js was not found in PATH. Install the repository Node.js requirement before preparing identity configuration.' }

& $node.Source (Join-Path $PSScriptRoot 'prepare-network-identity-config.mjs') --discovery $discoveryPath --accounts $Accounts --output $setupPath
if ($LASTEXITCODE -ne 0) { throw 'Identity setup preparation failed.' }

$setup = Get-Content -LiteralPath $setupPath -Raw | ConvertFrom-Json
$summary = [pscustomobject]@{
  ok = $true
  discoveryPath = $discoveryPath
  setupPath = $setupPath
  accountCount = @($setup.identities).Count
  nextChecks = @(
    'Confirm chromeExecutablePath points to the Chrome installation you want to use.',
    'Replace each accountLabel and identityId with stable names.',
    'Confirm every proxyPort is an active, unique Clash/Mihomo inbound.',
    'Confirm those local inbounds actually route to distinct stable public egress IPs.',
    'Add DNS probe configuration before formal acceptance when DNS policy is proxy.'
  )
}
$summary | ConvertTo-Json -Depth 5
