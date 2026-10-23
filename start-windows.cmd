@echo off
REM Starts the StackReel API and web app. Open http://localhost:5173 when ready.
cd /d "%~dp0"
call npm run dev
pause
