@echo off
chcp 65001 >nul
setlocal

rem %~dp0 末尾带 \，若再包引号会把 " 转义掉，导致插件路径解析失败
set "EXT=%~dp0"
if "%EXT:~-1%"=="\" set "EXT=%EXT:~0,-1%"
for %%I in ("%EXT%\..\..") do set "ROOT=%%~fI"
set "DEMO=%EXT%\fixtures\demo.md"
set "CODE=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"

if not exist "%CODE%" (
  echo 找不到 Microsoft VS Code：
  echo   %CODE%
  pause
  exit /b 1
)

echo 用 VS Code 打开「带公文插件」的调试窗口...
echo ROOT=%ROOT%
echo EXT =%EXT%
echo DEMO=%DEMO%
echo.

rem 不要给带尾 \ 的路径加引号；此处 EXT 已去掉尾 \
call "%CODE%" "%ROOT%" --extensionDevelopmentPath="%EXT%" "%DEMO%"

echo.
echo 成功标志：Ctrl+Shift+P 能搜到「公文：」
echo 若仍没有：扩展侧边栏搜 gongwen / 公文 MD
pause
