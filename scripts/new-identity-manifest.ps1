param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9-]{2,63}$')][string]$IdentityId,
  [Parameter(Mandatory = $true)][string]$AccountLabel,
  [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$ProxyPort,
  [string]$ProxyHost = '127.0.0.1',
  [ValidateSet('http', 'https', 'socks5')][string]$ProxyProtocol = 'http',
  [string]$CountryCode = 'CN',
  [string]$Locale = 'zh-CN',
  [string]$Timezone = 'Asia/Shanghai',
  [string]$ChromePath = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  [string]$UserDataRoot = "$env:LOCALAPPDATA\KvBrowserBridge\profiles",
  [string]$OutputDirectory = '.\identities',
  [string]$DnsProbeUrl,
  [string[]]$ExpectedDnsResolvers = @(),
  [switch]$AllowIpv6
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-HttpsUrl {
  param([string]$Name, [string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return }
  $uri = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https') {
    throw "$Name must be an absolute HTTPS URL."
  }
}

Assert-HttpsUrl 'DnsProbeUrl' $DnsProbeUrl

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$manifestPath = Join-Path $resolvedOutput "$IdentityId.json"
if (Test-Path $manifestPath) {
  throw "Manifest already exists: $manifestPath. Rename it or remove it explicitly before generating a replacement."
}

$profilePath = Join-Path ([System.IO.Path]::GetFullPath($UserDataRoot)) $IdentityId
$networkVerification = [ordered]@{
  publicIpProbeUrl = 'https://api.ipify.org?format=json'
  ipv6ProbeUrl = 'https://api6.ipify.org?format=json'
  timeoutMs = 20000
  allowedWebrtcCandidates = @()
}
if (-not [string]::IsNullOrWhiteSpace($DnsProbeUrl)) {
  $networkVerification.dnsProbeUrl = $DnsProbeUrl
  $networkVerification.expectedDnsResolvers = @($ExpectedDnsResolvers)
}

$manifest = [ordered]@{
  schemaVersion = 1
  identityId = $IdentityId
  workspaceId = 'default'
  platform = 'xiaohongshu'
  accountLabel = $AccountLabel
  mode = 'native-stable'
  browser = [ordered]@{
    executablePath = [System.IO.Path]::GetFullPath($ChromePath)
    userDataDir = $profilePath
    profileDirectory = 'Default'
  }
  environment = [ordered]@{
    osFamily = 'windows'
    locale = $Locale
    timezone = $Timezone
    screen = [ordered]@{ width = 1920; height = 1080; deviceScaleFactor = 1 }
  }
  proxy = [ordered]@{
    id = "clash-$IdentityId"
    protocol = $ProxyProtocol
    host = $ProxyHost
    port = $ProxyPort
    authMode = 'none'
    countryCode = $CountryCode.ToUpperInvariant()
    timezone = $Timezone
    locale = $Locale
  }
  policies = [ordered]@{
    webrtc = 'proxy-only'
    dns = 'proxy'
    ipv6 = $(if ($AllowIpv6) { 'default' } else { 'disabled' })
    allowConcurrentSessions = $false
  }
  networkVerification = $networkVerification
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  updatedAt = (Get-Date).ToUniversalTime().ToString('o')
}

$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8

$result = [ordered]@{
  ok = $true
  manifestPath = $manifestPath
  identityId = $IdentityId
  profilePath = $profilePath
  proxy = "$ProxyProtocol`://$ProxyHost`:$ProxyPort"
  requiresDnsConfiguration = [string]::IsNullOrWhiteSpace($DnsProbeUrl)
  nextCommand = ".\scripts\prepare-network-isolation.ps1 -Manifest `"$manifestPath`""
}
$result | ConvertTo-Json -Depth 4
