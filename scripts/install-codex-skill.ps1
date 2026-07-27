[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $HOME '.codex\skills\kv-browser-bridge'),
  [switch]$Force
)

$source = Join-Path $PSScriptRoot '..\skills\kv-browser-bridge\SKILL.md'
$source = [System.IO.Path]::GetFullPath($source)
$target = Join-Path $Destination 'SKILL.md'

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Canonical Kv Browser Bridge Skill was not found: $source"
}

if (Test-Path -LiteralPath $target -PathType Leaf) {
  $sameContent = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq
    (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  if ($sameContent) {
    Write-Output "Kv Browser Bridge Skill is already current: $target"
    exit 0
  }

  if (-not $Force) {
    throw "A different Skill already exists at $target. Re-run with -Force only after reviewing it."
  }
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
Write-Output "Installed Kv Browser Bridge Skill: $target"
