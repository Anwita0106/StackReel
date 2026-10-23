@echo off
REM StackReel first-time setup (Windows). Installs all dependencies and the headless Chromium.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get Node 22 LTS from https://nodejs.org && pause && exit /b 1)
call npm run setup || (echo Setup failed. && pause && exit /b 1)
if not exist .env copy .env.example .env >nul
call npm run doctor
pause
