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

echo Starting QQ Agent...
echo Open the panel at http://127.0.0.1:3081
call "%NPMPATH%" run start
set "AGENT_EXIT=%ERRORLEVEL%"
if not "%AGENT_EXIT%"=="0" echo [X] Agent exited with code %AGENT_EXIT%. Check the error above.
if not defined QQ_AGENT_NO_PAUSE pause
exit /b %AGENT_EXIT%

:ensure_dependencies
if exist "node_modules\.bin\tsx.cmd" if exist "node_modules\sharp\package.json" exit /b 0
echo [!] Installing dependencies...
if exist "package-lock.json" (
  call "%NPMPATH%" ci --no-fund --no-audit
) else (
  call "%NPMPATH%" install --no-fund --no-audit
)
exit /b %ERRORLEVEL%
