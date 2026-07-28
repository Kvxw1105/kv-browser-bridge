$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'KV UIA Integration Harness'
$form.Name = 'KvUiaIntegrationHarness'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(520, 240)
$form.TopMost = $false

$input = New-Object System.Windows.Forms.TextBox
$input.Name = 'InputField'
$input.AccessibleName = 'Integration Input'
$input.Location = New-Object System.Drawing.Point(24, 30)
$input.Size = New-Object System.Drawing.Size(450, 32)
$form.Controls.Add($input)

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
  $result.Text = "Applied:$($input.Text)"
  $form.Text = "KV UIA Integration Harness - Applied:$($input.Text)"
})

$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
