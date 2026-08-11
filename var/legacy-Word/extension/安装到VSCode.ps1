# Link this folder into VS Code / Cursor extensions dir (no vsix).
$ErrorActionPreference = "Stop"
$extSrc = $PSScriptRoot
$pkg = Get-Content (Join-Path $extSrc "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = [string]$pkg.version
$name = [string]$pkg.name
$publisher = [string]$pkg.publisher
if (-not $ver) { $ver = "0.0.0" }
$folderName = "$publisher.$name-$ver"

$targets = @()
$targets += (Join-Path $env:USERPROFILE ".vscode\extensions")
$cursorExt = Join-Path $env:USERPROFILE ".cursor\extensions"
if (Test-Path (Split-Path $cursorExt -Parent)) {
  $targets += $cursorExt
}

foreach ($destParent in $targets) {
  New-Item -ItemType Directory -Force -Path $destParent | Out-Null
  # remove old junctions for this extension
  Get-ChildItem $destParent -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "$publisher.$name-*" } |
    ForEach-Object {
      cmd /c rmdir "$($_.FullName)" 2>$null | Out-Null
      if (Test-Path $_.FullName) { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
    }
  $dest = Join-Path $destParent $folderName
  cmd /c mklink /J "$dest" "$extSrc" | Out-Null
  if (-not (Test-Path (Join-Path $dest "package.json"))) {
    throw "mklink failed: $dest"
  }
  Write-Host "OK junction: $dest"
}

Write-Host "version=$ver"
Write-Host "Reload window (Developer: Reload Window) or restart Cursor/VS Code."
Write-Host "Command palette: gongwen.account.login / openMdEditor"
