@echo off
REM Build OpenChatCut (ModuleX changes) on Windows: install, test, build the
REM installer and the portable executable, then print their SHA-256.
REM Needs Node.js 24 (node -v) and Git. Run from the repository root.
setlocal
cd /d "%~dp0"

where node >nul 2>&1 || (echo Node.js 24 is required: https://nodejs.org & exit /b 1)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if not "%NODE_MAJOR%"=="24" (echo Node.js 24 is required, found %NODE_MAJOR%. & exit /b 1)

echo === Installing dependencies (npm ci) ===
call npm ci --loglevel=error || exit /b 1

echo === Security regression suite ===
call npm run verify:security || exit /b 1

if /i "%1"=="--full-tests" (
  echo === Full test suite ===
  call npm test || exit /b 1
)

echo === Building installer and portable executable ===
call npm run desktop:dist:win:all || exit /b 1

echo.
echo === Output ===
for %%f in (release\*.exe) do (
  echo %%~ff
  powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '%%~ff').Hash.ToLower()"
)
endlocal
