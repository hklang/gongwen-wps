# 本机启动公文中转（Windows）。Key 从 editor/settings.py 同步。
$ErrorActionPreference = "Stop"
$Dir = $PSScriptRoot
Set-Location $Dir

python bootstrap_local.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_.Split('=', 2)
  Set-Item -Path "Env:$k" -Value $v.Trim()
}
$env:PYTHONUNBUFFERED = "1"

New-Item -ItemType Directory -Force -Path data, logs | Out-Null

Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like "*relay_server.py*") } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
Start-Sleep -Seconds 1

$outLog = Join-Path $Dir "logs\relay.out.log"
$errLog = Join-Path $Dir "logs\relay.err.log"
$proc = Start-Process -FilePath "python" -ArgumentList "relay_server.py" -WorkingDirectory $Dir `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
Set-Content -Path (Join-Path $Dir "relay.pid") -Value $proc.Id -Encoding ascii
Start-Sleep -Seconds 2

try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
  Write-Host ("local relay ok pid=" + $proc.Id + " " + ($h | ConvertTo-Json -Compress))
} catch {
  Write-Host "started but health failed; see logs\relay.*.log"
  if (Test-Path $errLog) { Get-Content $errLog -Tail 40 }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 40 }
  exit 1
}
