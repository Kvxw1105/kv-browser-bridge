[CmdletBinding()]
param(
  [string]$OutputPath,
  [switch]$Compact
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$chromeByPath = @{}
$proxyByEndpoint = @{}
$warnings = New-Object System.Collections.Generic.List[string]

function Add-ChromeCandidate {
  param([string]$Path, [string]$Source)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  try { $resolved = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path)) } catch { return }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { return }
  $key = $resolved.ToLowerInvariant()
  if (-not $chromeByPath.ContainsKey($key)) {
    $chromeByPath[$key] = [pscustomobject]@{
      path = $resolved
      source = $Source
    }
  }
}

function Add-ProxyCandidate {
  param(
    [string]$Address,
    [int]$Port,
    [string]$ProcessName,
    [string]$ProcessPath,
    [int]$ProcessId,
    [string]$Source,
    [string]$Kind
  )
  if ($Port -lt 1 -or $Port -gt 65535) { return }
  $hostName = if ($Address -eq '::1') { '::1' } else { '127.0.0.1' }
  $key = "${hostName}:${Port}"
  if ($proxyByEndpoint.ContainsKey($key)) { return }
  $proxyByEndpoint[$key] = [pscustomobject]@{
    host = $hostName
    port = $Port
    processName = $ProcessName
    processPath = $ProcessPath
    processId = $ProcessId
    source = $Source
    kind = $Kind
  }
}

$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
foreach ($candidate in @(
  @{ path = (Join-Path $programFiles 'Google\Chrome\Application\chrome.exe'); source = 'program-files' },
  @{ path = (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe'); source = 'program-files-x86' },
  @{ path = (Join-Path $localAppData 'Google\Chrome\Application\chrome.exe'); source = 'local-app-data' },
  @{ path = (Join-Path $programFiles 'Chromium\Application\chrome.exe'); source = 'chromium-program-files' },
  @{ path = (Join-Path $localAppData 'Chromium\Application\chrome.exe'); source = 'chromium-local-app-data' }
)) {
  Add-ChromeCandidate -Path $candidate.path -Source $candidate.source
}

foreach ($registryPath in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
)) {
  $entry = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
  if ($null -ne $entry) {
    Add-ChromeCandidate -Path ([string]$entry.'(default)') -Source "registry:$registryPath"
  }
}

$processes = @()
try {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
  $warnings.Add("Process inspection unavailable: $($_.Exception.Message)")
}

$processById = @{}
foreach ($process in $processes) {
  try { $processById[[int]$process.ProcessId] = $process } catch { }
  if ([string]$process.Name -match '^(chrome|chromium)\.exe$') {
    Add-ChromeCandidate -Path ([string]$process.ExecutablePath) -Source 'running-process'
  }
}

$commonProxyPorts = New-Object System.Collections.Generic.HashSet[int]
foreach ($port in @(7890, 7891, 7892, 7893, 7894, 1080, 8080)) { [void]$commonProxyPorts.Add($port) }
foreach ($port in 17890..17920) { [void]$commonProxyPorts.Add($port) }

$listeners = @()
try {
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
} catch {
  $warnings.Add("TCP listener inspection unavailable: $($_.Exception.Message)")
}

foreach ($listener in $listeners) {
  $address = [string]$listener.LocalAddress
  if ($address -notin @('127.0.0.1', '0.0.0.0', '::1', '::')) { continue }
  $port = [int]$listener.LocalPort
  $pidValue = [int]$listener.OwningProcess
  $process = if ($processById.ContainsKey($pidValue)) { $processById[$pidValue] } else { $null }
  $processName = if ($null -ne $process) { [string]$process.Name } else { '' }
  $processPath = if ($null -ne $process) { [string]$process.ExecutablePath } else { '' }
  $knownProxyProcess = $processName -match '(?i)(clash|mihomo|clash-verge|verge-mihomo)'
  $commonPort = $commonProxyPorts.Contains($port)
  if (-not $knownProxyProcess -and -not $commonPort) { continue }
  $kind = if ($knownProxyProcess -and $commonPort) { 'likely-proxy-inbound' } elseif ($knownProxyProcess) { 'proxy-process-listener' } else { 'common-proxy-port' }
  Add-ProxyCandidate -Address $address -Port $port -ProcessName $processName -ProcessPath $processPath -ProcessId $pidValue -Source 'tcp-listener' -Kind $kind
}

$chromeCandidates = @($chromeByPath.Values | Sort-Object path)
$proxyCandidates = @($proxyByEndpoint.Values | Sort-Object host, port)
if ($chromeCandidates.Count -eq 0) { $warnings.Add('No Chrome or Chromium executable was discovered in common Windows locations.') }
if ($proxyCandidates.Count -eq 0) { $warnings.Add('No likely Clash or Mihomo local proxy listener was discovered. Start the proxy client and run discovery again.') }
if ($chromeCandidates.Count -gt 1) { $warnings.Add('Multiple Chrome or Chromium executables were found. Confirm which installation should own the identity profiles.') }

$result = [pscustomobject]@{
  schemaVersion = 1
  platform = 'windows'
  observedAt = (Get-Date).ToUniversalTime().ToString('o')
  recommendedChromePath = if ($chromeCandidates.Count -gt 0) { $chromeCandidates[0].path } else { $null }
  chromeCandidates = $chromeCandidates
  proxyCandidates = $proxyCandidates
  warnings = @($warnings)
}

$depth = 8
$json = if ($Compact) { $result | ConvertTo-Json -Depth $depth -Compress } else { $result | ConvertTo-Json -Depth $depth }
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
  $resolvedOutput = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($OutputPath))
  $directory = Split-Path -Parent $resolvedOutput
  if (-not [string]::IsNullOrWhiteSpace($directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  [System.IO.File]::WriteAllText($resolvedOutput, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}
Write-Output $json
