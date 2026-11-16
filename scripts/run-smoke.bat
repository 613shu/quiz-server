@echo off
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)
set /p AI_API_KEY=Paste the Gemini API key and press Enter: 
set AI_ENABLED=1
set AI_BACKEND=studio
set AI_MODEL=gemini-3.5-flash-lite
node scripts\ai-smoke.js
set AI_API_KEY=
pause
