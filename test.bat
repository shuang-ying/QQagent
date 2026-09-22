@echo off
REM ============================================================
REM  Run all verification tests.
REM  Stage 1 is fully offline; stage 2 / 3-5 make real network
REM  calls to the API configured in config/providers.yaml.
REM  Stage 6 / 7 need the Agent running (start.bat) - skipped if not.
REM  If the default provider is down, point the network tests at a
REM  working one:  set TEST_PROVIDER=deepseek  /  set E2E_PROVIDER=deepseek
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

set "FAILED="

echo.
echo === Typecheck ===
call "%NPMPATH%" exec --no -- tsc -p tsconfig.json --noEmit
if errorlevel 1 (
  echo [X] Typecheck FAILED
  set "FAILED=1"
) else (
  echo [OK] Typecheck passed
)

echo.
echo === Stage 1: NapCat integration (offline) ===
call "%NPMPATH%" exec --no -- tsx scripts/test-stage1.ts
if errorlevel 1 set "FAILED=1"

echo.
echo === Stage 2: Any-API + model discovery ===
call "%NPMPATH%" exec --no -- tsx scripts/test-stage2.ts
if errorlevel 1 set "FAILED=1"

echo.
echo === Stage 3/4/5: Persona / Memory / Emotion / Compression ===
call "%NPMPATH%" exec --no -- tsx scripts/test-stage345.ts
if errorlevel 1 set "FAILED=1"

echo.
echo === Stage 6: Web admin panel ===
REM Needs a running Agent; skip gracefully when the port is not listening.
netstat -an | findstr /C:"127.0.0.1:3081" | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [~] SKIPPED - Agent is not running ^(start.bat^), panel tests need it.
) else (
  call "%NPMPATH%" exec --no -- tsx scripts/test-stage6.ts
  if errorlevel 1 set "FAILED=1"
)

echo.
echo === Stage 7: Settings / Personas / Model roles / Semantic memory ===
netstat -an | findstr /C:"127.0.0.1:3081" | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [~] Offline parts only - Agent is not running, HTTP parts will skip.
)
call "%NPMPATH%" exec --no -- tsx scripts/test-stage7.ts
if errorlevel 1 set "FAILED=1"

echo.
echo ============================================================
if defined FAILED (
  echo   [X] Some tests FAILED
) else (
  echo   [OK] All tests passed
)
echo ============================================================
pause
