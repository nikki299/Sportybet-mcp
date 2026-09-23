@echo off
setlocal
cd /d "%~dp0"

echo SportyBet Telegram Bot
 echo.
if not exist package.json (
  echo ERROR: Run this file from the extracted Sportybet-mcp folder.
  pause
  exit /b 1
)

if not exist .env (
  copy /Y .env.example .env >nul
  echo A local settings file was created.
  echo Add your BotFather token on the TELEGRAM_BOT_TOKEN line, save it, then return here.
  notepad .env
  pause
)

if not exist node_modules (
  echo Installing dependencies. This may take a minute...
  call npm.cmd ci
  if errorlevel 1 goto failed
)

if not exist dist\telegram-bot.js (
  echo Building the bot...
  call npm.cmd run build
  if errorlevel 1 goto failed
)

echo Starting the Telegram bot. Keep this window open.
call npm.cmd run bot
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo The bot could not start. Read the error above.
pause
exit /b 1
