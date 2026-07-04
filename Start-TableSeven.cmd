@echo off
title TABLE SEVEN - private blackjack table
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required to run Table Seven.
  echo   Install it free from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)
echo.
echo   Opening TABLE SEVEN ...
echo   Keep this window open while you play. Close it to shut the table.
echo.
start "" http://localhost:7777
node table-server.js
pause
