@echo off
chcp 65001 >nul
set "DST=%~dp0media\vditor"
set "SRC=%~dp0..\editor\vendor\vditor"
if not exist "%SRC%\index.min.js" (
  echo 找不到源：%SRC%
  pause
  exit /b 1
)
if exist "%DST%" rmdir "%DST%" 2>nul
if exist "%DST%" rmdir /s /q "%DST%" 2>nul
mklink /J "%DST%" "%SRC%"
echo OK
pause
