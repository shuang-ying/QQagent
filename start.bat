@echo off
REM ============================================================
REM  QQ Agent launcher - just double-click this file.
REM  ASCII-only on purpose: cmd can mis-decode UTF-8 .bat files.
REM ============================================================
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0"

REM Resolve npm to a FULL PATH before calling it.
REM NOTE: `call "npm.cmd"` (bare name, quoted) breaks npm's own
REM %~dp0 self-resolution and fails with MODULE_NOT_FOUND.
set "NPMPATH="
for /f "delims=" %%i in ('where npm.cmd 2^>nul') do if not defined NPMPATH set "NPMPATH=%%i"

if not defined NPMPATH (
  echo.
  echo [X] npm not found. Please install Node.js v22.5 or newer.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo [!] Dependencies not found. Running install first...
  echo.
  call "%NPMPATH%" install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo [X] Install failed. Check your network and Node.js version ^(need v22.5+^).
    pause
    exit /b 1
  )
)

echo.
echo ============================================================
echo   Starting QQ Agent...
echo   Panel: http://127.0.0.1:3081
echo ============================================================
echo.

REM 延时2秒后自动打开浏览器面板（服务启动后自动跳转）
start "" cmd /c "timeout /t 1 /nobreak >nul && start http://127.0.0.1:3081"

call "%NPMPATH%" exec --no -- tsx src/index.ts

echo.
echo Agent stopped.
pause
