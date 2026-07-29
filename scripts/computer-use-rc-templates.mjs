export const computerUseRcRequiredFiles = Object.freeze([
  'apps/codex-mcp-server/dist/computer-status.js',
  'apps/codex-mcp-server/dist/computer-doctor.js',
  'apps/codex-mcp-server/dist/computer-server.js',
  'apps/codex-mcp-server/dist/codex-install.js',
  'apps/chrome-bridge/dist/install.js',
  'apps/extension/dist/manifest.json',
  'apps/windows-uia-driver/publish/kv-windows-uia-driver.exe',
  'CONTROL_PANEL.ps1',
  'OPEN_CONTROL_PANEL.cmd',
  'INSTALL.ps1',
  'INSTALL.cmd',
  'SMOKE.ps1',
  'SMOKE.cmd',
  'VERIFY.ps1',
  'VERIFY.cmd',
  'UNINSTALL.ps1',
  'UNINSTALL.cmd',
  'README.md',
  'release-manifest.json',
  'SHA256SUMS.txt',
]);

export function verifyScript() {
  return `param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Manifest = Join-Path $Root 'SHA256SUMS.txt'
if (-not (Test-Path $Manifest)) { throw "Checksum manifest missing: $Manifest" }
$Checked = 0
foreach ($Line in Get-Content -LiteralPath $Manifest) {
  if ([string]::IsNullOrWhiteSpace($Line)) { continue }
  $Parts = $Line -split '  ', 2
  if ($Parts.Count -ne 2) { throw "Malformed checksum entry: $Line" }
  $Expected = $Parts[0].Trim().ToLowerInvariant()
  $Relative = $Parts[1].Trim().Replace('/', [IO.Path]::DirectorySeparatorChar)
  $Target = Join-Path $Root $Relative
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { throw "Package file missing: $Relative" }
  $Actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "Checksum mismatch: $Relative" }
  $Checked += 1
}
if (-not $Quiet) { Write-Host "Integrity verified: $Checked files." -ForegroundColor Green }
`;
}

export function installScript() {
  return `param([switch]$SkipChromeHost)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host '[1/7] Verifying RC package integrity...'
& (Join-Path $Root 'VERIFY.ps1') -Quiet

Write-Host '[2/7] Checking Node.js and npm...'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]") | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $NodeMajor -lt 22) {
  throw "Node.js 22 or newer is required. Found major version $NodeMajor."
}

Write-Host '[3/7] Installing production dependencies...'
& npm ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

Write-Host '[4/7] Checking Windows UIA driver...'
$Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'
if (-not (Test-Path -LiteralPath $Driver -PathType Leaf)) { throw "Windows UIA driver missing: $Driver" }
$env:KV_WINDOWS_UIA_DRIVER = $Driver

if ($SkipChromeHost) {
  Write-Host '[5/7] Chrome Native Messaging host installation skipped by request.'
} else {
  Write-Host '[5/7] Installing Chrome Native Messaging host...'
  & node apps/chrome-bridge/dist/install.js install
  if ($LASTEXITCODE -ne 0) { throw "Chrome host installation failed with exit code $LASTEXITCODE." }
}

Write-Host '[6/7] Registering the managed KV block with Codex...'
& node apps/codex-mcp-server/dist/codex-install.js install
if ($LASTEXITCODE -ne 0) { throw "Codex registration failed with exit code $LASTEXITCODE." }
Write-Host 'Only the KV managed block is changed; the installer creates a backup before modifying existing Codex configuration.'

Write-Host '[7/7] Running diagnostics and unified status...'
$DoctorOutput = & node apps/codex-mcp-server/dist/computer-doctor.js --json
$DoctorExit = $LASTEXITCODE
$DoctorText = ($DoctorOutput | Out-String).Trim()
if ($DoctorText) { Write-Host $DoctorText }
if ($DoctorExit -ne 0) { throw "Computer Use diagnostics failed with exit code $DoctorExit." }

$StatusOutput = & node apps/codex-mcp-server/dist/computer-status.js --json
$StatusExit = $LASTEXITCODE
$StatusText = ($StatusOutput | Out-String).Trim()
if ($StatusText) { Write-Host $StatusText }
try {
  $Status = $StatusText | ConvertFrom-Json
} catch {
  throw "Unified status did not return valid JSON. Exit code: $StatusExit"
}

Write-Host "Installation completed. Unified state: $($Status.state)" -ForegroundColor Green
if (@($Status.nextActions).Count -gt 0) {
  Write-Host 'Next actions:'
  foreach ($Action in @($Status.nextActions)) { Write-Host " - $Action" }
} else {
  Write-Host 'Next actions: none.'
}
Write-Host 'Open Chrome extensions and load apps/extension/dist as an unpacked extension if it is not already installed.'
`;
}

export function uninstallScript() {
  return `param([switch]$KeepChromeHost)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required to remove the Codex integration.'
}

Write-Host 'Removing only the KV managed block from Codex configuration...'
& node apps/codex-mcp-server/dist/codex-install.js uninstall
if ($LASTEXITCODE -ne 0) { throw "Codex uninstall failed with exit code $LASTEXITCODE." }

if ($KeepChromeHost) {
  Write-Host 'Chrome Native Messaging host retained by request.'
} else {
  Write-Host 'Removing Chrome Native Messaging host...'
  & node apps/chrome-bridge/dist/install.js uninstall
  if ($LASTEXITCODE -ne 0) { throw "Chrome host uninstall failed with exit code $LASTEXITCODE." }
}

Write-Host 'Existing Codex configuration and KV-created backups were preserved.' -ForegroundColor Green
Write-Host 'Unified status after uninstall:'
$StatusOutput = & node apps/codex-mcp-server/dist/computer-status.js --json
$StatusExit = $LASTEXITCODE
$StatusText = ($StatusOutput | Out-String).Trim()
if ($StatusText) { Write-Host $StatusText }
try {
  $Status = $StatusText | ConvertFrom-Json
  Write-Host "State: $($Status.state)"
  foreach ($Action in @($Status.nextActions)) { Write-Host "Next: $Action" }
} catch {
  throw "Unified status did not return valid JSON after uninstall. Exit code: $StatusExit"
}
`;
}

export function smokeScript() {
  return `param([switch]$InstallCodex)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host '[1/3] Verifying package...'
& (Join-Path $Root 'VERIFY.ps1') -Quiet

$Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'
$env:KV_WINDOWS_UIA_DRIVER = $Driver
if ($InstallCodex) {
  & node apps/codex-mcp-server/dist/codex-install.js install
  if ($LASTEXITCODE -ne 0) { throw "Codex installation failed with exit code $LASTEXITCODE." }
}

Write-Host '[2/3] Running Computer Use doctor...'
$DoctorOutput = & node apps/codex-mcp-server/dist/computer-doctor.js --json
$DoctorExit = $LASTEXITCODE
$DoctorText = ($DoctorOutput | Out-String).Trim()
if ($DoctorText) { Write-Host $DoctorText }
try {
  $Doctor = $DoctorText | ConvertFrom-Json
} catch {
  throw "Doctor did not return valid JSON. Exit code: $DoctorExit"
}
if ($DoctorExit -ne 0 -or -not $Doctor.ok) {
  throw "Computer Use doctor reported a required failure. Exit code: $DoctorExit"
}

Write-Host '[3/3] Reading unified status...'
$StatusOutput = & node apps/codex-mcp-server/dist/computer-status.js --json
$StatusExit = $LASTEXITCODE
$StatusText = ($StatusOutput | Out-String).Trim()
if ($StatusText) { Write-Host $StatusText }
try {
  $Status = $StatusText | ConvertFrom-Json
} catch {
  throw "Unified status did not return valid JSON. Exit code: $StatusExit"
}
Write-Host "Smoke completed. Unified state: $($Status.state)" -ForegroundColor Green
if ($StatusExit -ne 0) {
  Write-Host "Unified status returned exit code $StatusExit with a valid '$($Status.state)' snapshot; the snapshot remains authoritative."
}
exit 0
`;
}

export function commandWrapper(script) {
  return [
    '@echo off',
    'setlocal',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${script}"`,
    'set EXIT_CODE=%ERRORLEVEL%',
    'echo.',
    'if not "%EXIT_CODE%"=="0" echo Operation failed with exit code %EXIT_CODE%.',
    'pause',
    'exit /b %EXIT_CODE%',
    '',
  ].join('\r\n');
}

export function controlPanelScript() {
  return `param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $env:LOCALAPPDATA 'KvBrowserBridge\\computer-use'
$Driver = Join-Path $Root 'apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe'
$McpServer = Join-Path $Root 'apps\\codex-mcp-server\\dist\\computer-server.js'
$StatusCommand = Join-Path $Root 'apps\\codex-mcp-server\\dist\\computer-status.js'
$DoctorCommand = Join-Path $Root 'apps\\codex-mcp-server\\dist\\computer-doctor.js'
$PackageManifest = Join-Path $Root 'apps\\codex-mcp-server\\package.json'
$script:StatusSnapshot = $null
$script:LastRawJson = ''
$script:ActionButtons = @()
$script:IsBusy = $false
$env:KV_WINDOWS_UIA_DRIVER = $Driver

function Get-PackageVersion {
  try {
    return [string]((Get-Content -LiteralPath $PackageManifest -Raw | ConvertFrom-Json).version)
  } catch {
    return 'unknown'
  }
}

$PackageVersion = Get-PackageVersion

$form = New-Object System.Windows.Forms.Form
$form.Text = 'KV Computer Use Control Center'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(980, 760)
$form.MinimumSize = New-Object System.Drawing.Size(820, 650)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock = 'Fill'
$layout.Padding = New-Object System.Windows.Forms.Padding(18)
$layout.ColumnCount = 1
$layout.RowCount = 5
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 76)))
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 205)))
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 105)))
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 42)))
$form.Controls.Add($layout)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Fill'
$title = New-Object System.Windows.Forms.Label
$title.Text = 'KV Computer Use Runtime'
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 18)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(4, 2)
$header.Controls.Add($title)
$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Windows Alpha RC control center - local Codex + Chrome + Windows UIA'
$subtitle.ForeColor = [System.Drawing.Color]::DimGray
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(7, 40)
$header.Controls.Add($subtitle)
$layout.Controls.Add($header, 0, 0)

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Dock = 'Fill'
$statusPanel.BorderStyle = 'FixedSingle'
$statusHeadline = New-Object System.Windows.Forms.Label
$statusHeadline.Text = 'CHECKING'
$statusHeadline.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 14)
$statusHeadline.AutoSize = $true
$statusHeadline.Location = New-Object System.Drawing.Point(14, 12)
$statusPanel.Controls.Add($statusHeadline)
$statusDetails = New-Object System.Windows.Forms.TextBox
$statusDetails.Multiline = $true
$statusDetails.ReadOnly = $true
$statusDetails.BorderStyle = 'None'
$statusDetails.BackColor = [System.Drawing.SystemColors]::Window
$statusDetails.WordWrap = $true
$statusDetails.ScrollBars = 'Vertical'
$statusDetails.Anchor = 'Top,Bottom,Left,Right'
$statusDetails.Location = New-Object System.Drawing.Point(16, 47)
$statusDetails.Size = New-Object System.Drawing.Size(900, 142)
$statusPanel.Controls.Add($statusDetails)
$layout.Controls.Add($statusPanel, 0, 1)

$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = 'Fill'
$buttonPanel.AutoScroll = $true
$buttonPanel.WrapContents = $true
$buttonPanel.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 4)
$layout.Controls.Add($buttonPanel, 0, 2)

$output = New-Object System.Windows.Forms.TextBox
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Both'
$output.WordWrap = $false
$output.Dock = 'Fill'
$output.Font = New-Object System.Drawing.Font('Consolas', 9)
$output.ShortcutsEnabled = $true
$layout.Controls.Add($output, 0, 3)

$footer = New-Object System.Windows.Forms.FlowLayoutPanel
$footer.Dock = 'Fill'
$footer.FlowDirection = 'RightToLeft'
$footer.WrapContents = $false
$layout.Controls.Add($footer, 0, 4)
$uninstall = New-Object System.Windows.Forms.Button
$uninstall.Text = 'Uninstall'
$uninstall.Size = New-Object System.Drawing.Size(130, 32)
$footer.Controls.Add($uninstall)
$feedback = New-Object System.Windows.Forms.Label
$feedback.Text = 'Ready'
$feedback.AutoEllipsis = $true
$feedback.TextAlign = 'MiddleLeft'
$feedback.Size = New-Object System.Drawing.Size(680, 32)
$footer.Controls.Add($feedback)

function Append-Output {
  param([string]$Text, [string]$Level = 'INFO')
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  foreach ($Line in ($Text -split "\\r?\\n")) {
    if ([string]::IsNullOrWhiteSpace($Line)) { continue }
    $Timestamp = Get-Date -Format 'HH:mm:ss'
    $output.AppendText("[$Timestamp] [$Level] $Line" + [Environment]::NewLine)
  }
  $output.SelectionStart = $output.TextLength
  $output.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

function Set-Feedback([string]$Text) {
  $feedback.Text = $Text
  $feedback.Refresh()
}

function Set-Busy([bool]$Busy, [string]$Message = 'Working...') {
  $script:IsBusy = $Busy
  foreach ($Button in $script:ActionButtons) { $Button.Enabled = -not $Busy }
  $uninstall.Enabled = -not $Busy
  $form.UseWaitCursor = $Busy
  if ($Busy) { Set-Feedback $Message }
}

function ConvertTo-CommandLineArgument([string]$Value) {
  if ($Value -notmatch '[\\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\\"') + '"'
}

function Invoke-CapturedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = $Root
  )
  $Info = New-Object System.Diagnostics.ProcessStartInfo
  $Info.FileName = $FilePath
  $Info.Arguments = (($Arguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join ' ')
  $Info.WorkingDirectory = $WorkingDirectory
  $Info.UseShellExecute = $false
  $Info.CreateNoWindow = $true
  $Info.RedirectStandardOutput = $true
  $Info.RedirectStandardError = $true
  $Process = New-Object System.Diagnostics.Process
  $Process.StartInfo = $Info
  try {
    if (-not $Process.Start()) { throw "Could not start $FilePath." }
    $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
    $StderrTask = $Process.StandardError.ReadToEndAsync()
    while (-not $Process.WaitForExit(100)) {
      [System.Windows.Forms.Application]::DoEvents()
    }
    $Stdout = $StdoutTask.Result
    $Stderr = $StderrTask.Result
    $ExitCode = $Process.ExitCode
    return [pscustomobject]@{
      Stdout = [string]$Stdout
      Stderr = [string]$Stderr
      ExitCode = [int]$ExitCode
    }
  } catch {
    return [pscustomobject]@{
      Stdout = ''
      Stderr = $_.Exception.Message
      ExitCode = -1
    }
  } finally {
    $Process.Dispose()
  }
}

function ConvertFrom-CommandJson([string]$Stdout) {
  if ([string]::IsNullOrWhiteSpace($Stdout)) { return $null }
  try {
    return ($Stdout.Trim() | ConvertFrom-Json)
  } catch {
    $Lines = @($Stdout -split "\\r?\\n")
    [array]::Reverse($Lines)
    foreach ($Line in $Lines) {
      if ($Line.TrimStart().StartsWith('{')) {
        try { return ($Line | ConvertFrom-Json) } catch { }
      }
    }
  }
  return $null
}

function Invoke-JsonCommand {
  param([string]$CommandPath, [string]$Label)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Append-Output 'Node.js is not installed or is not available on PATH.' 'ERROR'
    return $null
  }
  Append-Output "$Label started."
  $Result = Invoke-CapturedProcess 'node' @($CommandPath, '--json')
  if (-not [string]::IsNullOrWhiteSpace($Result.Stderr)) {
    Append-Output $Result.Stderr 'STDERR'
  }
  $Data = ConvertFrom-CommandJson $Result.Stdout
  if ($null -eq $Data) {
    if (-not [string]::IsNullOrWhiteSpace($Result.Stdout)) { Append-Output $Result.Stdout 'STDOUT' }
    Append-Output "$Label failed: stdout did not contain valid JSON (exit code $($Result.ExitCode))." 'ERROR'
    return $null
  }
  if ($Result.ExitCode -ne 0) {
    Append-Output "$Label returned exit code $($Result.ExitCode), but valid stdout JSON was accepted." 'WARN'
  }
  return [pscustomobject]@{
    Data = $Data
    Raw = [string]$Result.Stdout
    Stderr = [string]$Result.Stderr
    ExitCode = [int]$Result.ExitCode
  }
}

function Get-StatusCheck($Snapshot, [string]$Name) {
  return @($Snapshot.runtime.checks | Where-Object { $_.name -eq $Name } | Select-Object -First 1)[0]
}

function Format-Availability($Check) {
  if ($null -eq $Check) { return 'unknown' }
  if ($Check.ok) { return 'yes' }
  return 'no'
}

function Get-StateColor([string]$State) {
  switch ($State) {
    'ready' { return [System.Drawing.Color]::ForestGreen }
    'degraded' { return [System.Drawing.Color]::DarkOrange }
    'not-installed' { return [System.Drawing.Color]::Chocolate }
    'unavailable' { return [System.Drawing.Color]::Firebrick }
    default { return [System.Drawing.Color]::SlateGray }
  }
}

function Show-Checking {
  $statusHeadline.Text = 'CHECKING'
  $statusHeadline.ForeColor = [System.Drawing.Color]::SlateGray
  $statusDetails.Text = 'Reading unified Computer Use status...'
}

function Get-NextActionsText($Snapshot) {
  $Actions = @($Snapshot.nextActions)
  if ($Actions.Count -eq 0) { return 'none' }
  return ($Actions -join ' | ')
}

function Update-StatusDisplay($Snapshot) {
  $Uia = Get-StatusCheck $Snapshot 'windows-uia-sidecar'
  $Chrome = Get-StatusCheck $Snapshot 'chrome-bridge'
  $Receipts = Get-StatusCheck $Snapshot 'receipt-directory'
  $State = [string]$Snapshot.state
  $statusHeadline.Text = $State.ToUpperInvariant()
  $statusHeadline.ForeColor = Get-StateColor $State
  $statusDetails.Lines = @(
    "Generated: $($Snapshot.generatedAt)    Package: $PackageVersion",
    "Codex installed: $($Snapshot.codex.installed)    Windows UIA available: $(Format-Availability $Uia)",
    "Chrome Bridge available: $(Format-Availability $Chrome)    Receipt directory writable: $(Format-Availability $Receipts)",
    "Required checks: $($Snapshot.runtime.requiredPassed)/$($Snapshot.runtime.requiredTotal)    Optional checks: $($Snapshot.runtime.optionalPassed)/$($Snapshot.runtime.optionalTotal)",
    "Next actions: $(Get-NextActionsText $Snapshot)"
  )
  Set-Feedback "Unified state: $State"
}

function Get-StatusSummary($Snapshot) {
  $Uia = Get-StatusCheck $Snapshot 'windows-uia-sidecar'
  $Chrome = Get-StatusCheck $Snapshot 'chrome-bridge'
  $Receipts = Get-StatusCheck $Snapshot 'receipt-directory'
  $Failed = @($Snapshot.runtime.checks | Where-Object { -not $_.ok })
  $Lines = @(
    'KV Computer Use Runtime status',
    "generatedAt: $($Snapshot.generatedAt)",
    "overall state: $($Snapshot.state)",
    "package version: $PackageVersion",
    "Codex installed: $($Snapshot.codex.installed)",
    "Windows UIA available: $(Format-Availability $Uia)",
    "Chrome Bridge available: $(Format-Availability $Chrome)",
    "receipts writable: $(Format-Availability $Receipts)",
    "required checks: $($Snapshot.runtime.requiredPassed)/$($Snapshot.runtime.requiredTotal)",
    "optional checks: $($Snapshot.runtime.optionalPassed)/$($Snapshot.runtime.optionalTotal)",
    '',
    'failed checks:'
  )
  if ($Failed.Count -eq 0) {
    $Lines += ' - none'
  } else {
    foreach ($Check in $Failed) {
      $Scope = if ($Check.required) { 'required' } else { 'optional' }
      $Lines += " - $($Check.name) [$Scope]: $($Check.message)"
    }
  }
  $Lines += ''
  $Lines += 'nextActions:'
  if (@($Snapshot.nextActions).Count -eq 0) {
    $Lines += ' - none'
  } else {
    foreach ($Action in @($Snapshot.nextActions)) { $Lines += " - $Action" }
  }
  $Lines += ''
  $Lines += "UIA Driver path: $Driver"
  $Lines += "MCP server path: $($Snapshot.codex.serverPath)"
  $Lines += "RC root: $Root"
  $Lines += "logs directory: $LogDir"
  return ($Lines -join [Environment]::NewLine)
}

function Refresh-Status {
  Show-Checking
  Append-Output 'Refreshing unified status...'
  $Result = Invoke-JsonCommand $StatusCommand 'Unified status'
  if ($null -eq $Result) {
    $statusHeadline.Text = 'UNAVAILABLE'
    $statusHeadline.ForeColor = Get-StateColor 'unavailable'
    $statusDetails.Text = 'The unified status command did not return valid JSON. See output for stdout, stderr, and exit details.'
    Set-Feedback 'Status refresh failed'
    return $false
  }
  $script:StatusSnapshot = $Result.Data
  $script:LastRawJson = $Result.Raw
  Update-StatusDisplay $script:StatusSnapshot
  Append-Output (Get-StatusSummary $script:StatusSnapshot)
  return $true
}

function Get-Remediation([string]$Name) {
  switch ($Name) {
    'node-runtime' { return 'Install Node.js 22 or newer and reopen the control center.' }
    'computer-mcp-build' { return 'Repair or re-extract the RC package, then run Verify Package.' }
    'windows-uia-sidecar' { return 'Confirm the packaged UIA driver exists and run Install / Repair.' }
    'windows-uia-observe' { return 'Run from an interactive Windows desktop session and inspect UIA driver diagnostics.' }
    'receipt-directory' { return 'Check LOCALAPPDATA permissions and retry.' }
    'chrome-bridge' { return 'Install the Native Messaging host, load the unpacked extension, and keep Chrome running.' }
    default { return 'Review the diagnostic message, repair the affected component, and retry.' }
  }
}

function Run-Diagnostics {
  $Result = Invoke-JsonCommand $DoctorCommand 'Diagnostics'
  if ($null -eq $Result) {
    Set-Feedback 'Diagnostics failed'
    return $false
  }
  $script:LastRawJson = $Result.Raw
  if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  }
  $RawPath = Join-Path $LogDir 'computer-doctor-latest.json'
  Set-Content -LiteralPath $RawPath -Value $Result.Raw -Encoding UTF8
  Append-Output 'Human-readable diagnostics:'
  foreach ($Check in @($Result.Data.checks)) {
    $Outcome = if ($Check.ok) { 'PASS' } else { 'FAIL' }
    $Scope = if ($Check.required) { 'required' } else { 'optional' }
    Append-Output "$Outcome | $($Check.name) | $Scope"
    Append-Output "message: $($Check.message)"
    $Remediation = if ($Check.ok) { 'No action required.' } else { Get-Remediation ([string]$Check.name) }
    Append-Output "remediation: $Remediation"
  }
  Append-Output "Raw diagnostic JSON: $RawPath"
  Set-Feedback "Diagnostics complete (exit code $($Result.ExitCode))"
  return $true
}

function Invoke-LocalScript {
  param([string]$Name, [string[]]$Arguments = @())
  $Path = Join-Path $Root $Name
  Append-Output "$Name started."
  $PowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($null -eq $PowerShell) { $PowerShell = Get-Command powershell -ErrorAction SilentlyContinue }
  if ($null -eq $PowerShell) {
    Append-Output 'Windows PowerShell was not found.' 'ERROR'
    return $false
  }
  $Result = Invoke-CapturedProcess $PowerShell.Source (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path) + $Arguments)
  if ($Result.Stdout) { Append-Output $Result.Stdout 'STDOUT' }
  if ($Result.Stderr) { Append-Output $Result.Stderr 'STDERR' }
  if ($Result.ExitCode -ne 0) {
    Append-Output "$Name failed with exit code $($Result.ExitCode)." 'ERROR'
    Set-Feedback "$Name failed"
    return $false
  }
  Append-Output "$Name completed."
  Set-Feedback "$Name completed"
  return $true
}

function Copy-Status {
  if ($null -eq $script:StatusSnapshot) {
    Append-Output 'No status snapshot is available. Refresh Status first.' 'ERROR'
    Set-Feedback 'No status to copy'
    return
  }
  try {
    [System.Windows.Forms.Clipboard]::SetText((Get-StatusSummary $script:StatusSnapshot))
    Append-Output 'Status summary copied to the clipboard.'
    Set-Feedback 'Status copied'
  } catch {
    Append-Output ("Could not copy status: " + $_.Exception.Message) 'ERROR'
    Set-Feedback 'Copy failed'
  }
}

function Copy-Output {
  try {
    [System.Windows.Forms.Clipboard]::SetText([string]$output.Text)
    Append-Output 'Output copied to the clipboard.'
    Set-Feedback 'Output copied'
  } catch {
    Append-Output ("Could not copy output: " + $_.Exception.Message) 'ERROR'
    Set-Feedback 'Copy failed'
  }
}

function Find-ChromeExecutable {
  foreach ($CommandName in @('chrome.exe', 'chrome')) {
    $Command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($null -ne $Command -and (Test-Path -LiteralPath $Command.Source -PathType Leaf)) {
      return $Command.Source
    }
  }
  $Candidates = @()
  if ($env:LOCALAPPDATA) {
    $Candidates += (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\Application\\chrome.exe')
  }
  $ProgramFiles = [Environment]::GetEnvironmentVariable('ProgramFiles')
  if ($ProgramFiles) {
    $Candidates += (Join-Path $ProgramFiles 'Google\\Chrome\\Application\\chrome.exe')
  }
  $ProgramFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($ProgramFilesX86) {
    $Candidates += (Join-Path $ProgramFilesX86 'Google\\Chrome\\Application\\chrome.exe')
  }
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return $Candidate }
  }
  return $null
}

function Open-ChromeExtensions {
  $Chrome = Find-ChromeExecutable
  if ([string]::IsNullOrWhiteSpace($Chrome)) {
    Append-Output 'Google Chrome executable was not found on PATH or in common user/system installation locations.' 'ERROR'
    Append-Output 'Open Chrome manually and navigate to chrome://extensions.' 'WARN'
    Set-Feedback 'Chrome not found'
    return
  }
  try {
    Start-Process -FilePath $Chrome -ArgumentList @('chrome://extensions') -ErrorAction Stop
    Append-Output "Opened chrome://extensions with $Chrome"
    Set-Feedback 'Chrome Extensions opened'
  } catch {
    Append-Output ("Could not open Chrome Extensions: " + $_.Exception.Message) 'ERROR'
    Append-Output 'Open Chrome manually and navigate to chrome://extensions.' 'WARN'
    Set-Feedback 'Chrome launch failed'
  }
}

function Open-Logs {
  try {
    if (-not (Test-Path -LiteralPath $LogDir)) {
      New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
      Append-Output "Created logs directory: $LogDir"
    }
    Start-Process -FilePath explorer.exe -ArgumentList @($LogDir) -ErrorAction Stop
    Append-Output "Opened logs directory: $LogDir"
    Set-Feedback 'Logs opened'
  } catch {
    Append-Output ("Could not open logs directory: " + $_.Exception.Message) 'ERROR'
    Set-Feedback 'Open Logs failed'
  }
}

function Invoke-UiAction {
  param([string]$Message, [scriptblock]$Action)
  if ($script:IsBusy) { return }
  Set-Busy $true $Message
  try {
    & $Action
  } catch {
    Append-Output $_.Exception.ToString() 'ERROR'
    Set-Feedback 'Operation failed'
  } finally {
    Set-Busy $false
  }
}

function Add-ActionButton {
  param([string]$Text, [string]$BusyText, [scriptblock]$Action)
  $Button = New-Object System.Windows.Forms.Button
  $Button.Text = $Text
  $Button.Size = New-Object System.Drawing.Size(150, 38)
  $Handler = {
    Invoke-UiAction $BusyText $Action
  }.GetNewClosure()
  $Button.Add_Click($Handler)
  $buttonPanel.Controls.Add($Button)
  $script:ActionButtons += $Button
}

Add-ActionButton 'Install / Repair' 'Installing or repairing...' {
  if (Invoke-LocalScript 'INSTALL.ps1') { Refresh-Status | Out-Null }
}
Add-ActionButton 'Run Diagnostics' 'Running diagnostics...' {
  Run-Diagnostics | Out-Null
}
Add-ActionButton 'Verify Package' 'Verifying package...' {
  Invoke-LocalScript 'VERIFY.ps1' | Out-Null
}
Add-ActionButton 'Refresh Status' 'Refreshing status...' {
  Refresh-Status | Out-Null
}
Add-ActionButton 'Copy Status' 'Copying status...' {
  Copy-Status
}
Add-ActionButton 'Chrome Extensions' 'Opening Chrome Extensions...' {
  Open-ChromeExtensions
}
Add-ActionButton 'Open Logs' 'Opening logs...' {
  Open-Logs
}
Add-ActionButton 'Copy Output' 'Copying output...' {
  Copy-Output
}

$uninstall.Add_Click({
  if ($script:IsBusy) { return }
  $Choice = [System.Windows.Forms.MessageBox]::Show(
    'Remove the KV managed Codex block?',
    'KV Computer Use',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($Choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  $KeepChoice = [System.Windows.Forms.MessageBox]::Show(
    'Keep the Chrome Native Messaging host installed?',
    'KV Computer Use',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  $UninstallArguments = if ($KeepChoice -eq [System.Windows.Forms.DialogResult]::Yes) { @('-KeepChromeHost') } else { @() }
  $UninstallAction = {
    if (Invoke-LocalScript 'UNINSTALL.ps1' $UninstallArguments) { Refresh-Status | Out-Null }
  }.GetNewClosure()
  Invoke-UiAction 'Uninstalling...' $UninstallAction
})

$form.Add_Shown({
  Invoke-UiAction 'Checking status...' { Refresh-Status | Out-Null }
})
[void]$form.ShowDialog()
`;
}

export function readme(version) {
  return `# KV Computer Use Runtime Alpha RC v${version}

This Windows test release candidate provides a responsive PowerShell WinForms control center, package integrity verification, rollback-aware Codex registration, the Chrome extension, and a self-contained Windows UIA driver. It remains an unsigned Alpha RC.

## Prerequisites

- Windows 10/11 x64
- Node.js 22 or newer
- npm and internet access for the first production dependency installation
- Google Chrome
- Codex CLI or another local MCP client

The Windows UIA driver is included as a self-contained executable; no separate .NET Runtime is required.

## Recommended start

Double-click:

- \`OPEN_CONTROL_PANEL.cmd\`

The control center shows the unified runtime state and provides Install / Repair, Run Diagnostics, Verify Package, Refresh Status, Copy Status, Chrome Extensions, Open Logs, Copy Output, and Uninstall. Every operation writes timestamped output. Raw doctor JSON is retained in the logs directory.

## Command-line route

\`INSTALL.cmd\`, \`SMOKE.cmd\`, \`VERIFY.cmd\`, and \`UNINSTALL.cmd\` preserve exit codes, show errors, and pause before closing. The underlying PowerShell scripts remain available for advanced use.

After installation, open chrome://extensions, enable Developer mode, choose Load unpacked, and select \`apps/extension/dist\`.

The installer manages only the marked KV Computer Use block in ~/.codex/config.toml and creates backups before changing an existing file. Receipts are redacted by default.
`;
}
