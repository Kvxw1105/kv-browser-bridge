$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'KV UIA Integration Harness'
$form.Name = 'KvUiaIntegrationHarness'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(520, 240)
$form.TopMost = $false

if (-not [string]::IsNullOrWhiteSpace($env:KV_UIA_HARNESS_DIAGNOSTIC_PATH)) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $diagnostic = [ordered]@{
    processId = $PID
    sessionId = (Get-Process -Id $PID).SessionId
    isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($env:KV_UIA_HARNESS_DIAGNOSTIC_PATH, $diagnostic, [Text.Encoding]::UTF8)
}

$inputField = New-Object System.Windows.Forms.TextBox
$inputField.Name = 'InputField'
$inputField.AccessibleName = 'Integration Input'
$inputField.Location = New-Object System.Drawing.Point(24, 30)
$inputField.Size = New-Object System.Drawing.Size(450, 32)
$form.Controls.Add($inputField)

$apply = New-Object System.Windows.Forms.Button
$apply.Name = 'ApplyButton'
$apply.AccessibleName = 'Apply Action'
$apply.Text = 'Apply'
$apply.Location = New-Object System.Drawing.Point(24, 82)
$apply.Size = New-Object System.Drawing.Size(120, 36)
$form.Controls.Add($apply)

$result = New-Object System.Windows.Forms.Label
$result.Name = 'ResultLabel'
$result.AccessibleName = 'Integration Result'
$result.Text = 'Waiting'
$result.AutoSize = $true
$result.Location = New-Object System.Drawing.Point(24, 142)
$form.Controls.Add($result)

$apply.Add_Click({
  try {
    if (-not [string]::IsNullOrWhiteSpace($env:KV_UIA_HARNESS_EVENT_PATH)) {
      [IO.File]::WriteAllText($env:KV_UIA_HARNESS_EVENT_PATH, 'entered', [Text.Encoding]::UTF8)
    }
    $applied = "Applied:$($inputField.Text)"
    $result.Text = $applied
    $result.AccessibleName = $applied
    $form.Text = "KV UIA Integration Harness - $applied"
    if (-not [string]::IsNullOrWhiteSpace($env:KV_UIA_HARNESS_RESULT_PATH)) {
      [IO.File]::WriteAllText($env:KV_UIA_HARNESS_RESULT_PATH, $applied, [Text.Encoding]::UTF8)
    }
  }
  catch {
    if (-not [string]::IsNullOrWhiteSpace($env:KV_UIA_HARNESS_EVENT_PATH)) {
      [IO.File]::WriteAllText($env:KV_UIA_HARNESS_EVENT_PATH, "error:$($_.Exception.ToString())", [Text.Encoding]::UTF8)
    }
    throw
  }
})

$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
