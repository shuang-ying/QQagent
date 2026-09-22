@echo off
REM ============================================================
REM  QQ Agent offline debug mode.
REM  Starts a Mock NapCat server so you can test WITHOUT a real QQ.
REM  Open a second window and run start.bat to connect the Agent.
REM  ASCII-only on purpose: cmd can mis-decode UTF-8 .bat files.
REM ============================================================
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

REM Resolve npm to a FULL PATH before calling it (see start.bat).
set "NPMPATH="
for /f "delims=" %%i in ('where npm.cmd 2^>nul') do if not defined NPMPATH set "NPMPATH=%%i"

if not defined NPMPATH (
  echo [X] npm not found. Please install Node.js v22.5 or newer.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [!] Installing dependencies...
  call "%NPMPATH%" install --no-fund --no-audit
)

echo.
echo ============================================================
echo   Mock NapCat server on ws://127.0.0.1:3001
echo.
echo   Type text and press Enter to simulate a group message
echo   that mentions the bot.
echo.
echo   Commands:
echo     /a ^<text^>   group message WITH @bot
echo     /g ^<text^>   group message WITHOUT @bot
echo     /p ^<text^>   private message
echo     /quit        exit
echo ============================================================
echo.

call "%NPMPATH%" exec --no -- tsx scripts/mock-napcat.ts
pause
