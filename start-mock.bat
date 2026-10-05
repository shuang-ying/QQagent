@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

REM Keep this file ASCII with CRLF. See .gitattributes.
set "NPMPATH="
for /f "delims=" %%i in ('where npm.cmd 2^>nul') do if not defined NPMPATH set "NPMPATH=%%i"
if not defined NPMPATH if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPMPATH=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPMPATH (
  echo [X] npm was not found. Install Node.js 22.16 or newer, then reopen this window.
  if not defined QQ_AGENT_NO_PAUSE pause
  exit /b 1
)

call :ensure_dependencies
if not "%ERRORLEVEL%"=="0" (
  echo [X] Dependency installation failed. Check the error above and your network.
  if not defined QQ_AGENT_NO_PAUSE pause
  exit /b 1
)

echo Starting the mock OneBot server...
echo Run start.bat in another window after configuring the matching port.
echo Type text for group @bot, /g for group chat, /p for private chat.
call "%NPMPATH%" run mock:onebot
set "MOCK_EXIT=%ERRORLEVEL%"
if not defined QQ_AGENT_NO_PAUSE pause
exit /b %MOCK_EXIT%

:ensure_dependencies
if exist "node_modules\.bin\tsx.cmd" if exist "node_modules\sharp\package.json" exit /b 0
echo [!] Installing dependencies...
if exist "package-lock.json" (
  call "%NPMPATH%" ci --no-fund --no-audit
) else (
  call "%NPMPATH%" install --no-fund --no-audit
)
exit /b %ERRORLEVEL%
