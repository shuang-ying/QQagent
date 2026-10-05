@echo off
REM ============================================================
REM Run offline and isolated regression tests via npm test.
REM Real API/QQ tests are manual and are not run here.
REM ============================================================
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

REM Resolve npm to a FULL PATH before calling it.
REM NOTE: `call "npm.cmd"` (bare name, quoted) breaks npm's own
REM %~dp0 self-resolution and fails with MODULE_NOT_FOUND.
set "NPMPATH="
for /f "delims=" %%i in ('where npm.cmd 2^>nul') do if not defined NPMPATH set "NPMPATH=%%i"
if not defined NPMPATH if exist "D:\NodeJs\npm.cmd" set "NPMPATH=D:\NodeJs\npm.cmd"

if not defined NPMPATH (
  echo [X] npm not found. Please install Node.js v22.5 or newer.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [!] Installing dependencies...
  call "%NPMPATH%" install --no-fund --no-audit
  if errorlevel 1 (
    echo [X] Install failed.
    pause
    exit /b 1
  )
)

call "%NPMPATH%" test
set "TEST_EXIT=%ERRORLEVEL%"
if "%TEST_EXIT%"=="0" (
  echo [OK] All offline and isolated tests passed.
) else (
  echo [X] Tests failed.
)
pause
exit /b %TEST_EXIT%
