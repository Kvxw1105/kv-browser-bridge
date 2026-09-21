[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $HOME '.codex\skills\kv-browser-bridge'),
  [switch]$Force
)

$installer = Join-Path $PSScriptRoot 'install-agent-skill.mjs'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Agent Skill installer was not found: $installer"
}

$arguments = @($installer, '--destination', $Destination, '--json')
if ($Force) { $arguments += '--force' }
& node @arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
