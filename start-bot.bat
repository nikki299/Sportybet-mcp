@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo SportyBet Telegram Bot
echo.
if not exist package.json (
  echo ERROR: Run this file from the extracted Sportybet-mcp folder.
  pause
  exit /b 1
)

if exist .env (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="TELEGRAM_BOT_TOKEN" set "TELEGRAM_BOT_TOKEN=%%B"
    if "%%A"=="GEMINI_API_KEY" set "GEMINI_API_KEY=%%B"
    if "%%A"=="GEMINI_MODEL" set "GEMINI_MODEL=%%B"
    if "%%A"=="SPORTYBET_REGION" set "SPORTYBET_REGION=%%B"
  )
)

if not defined TELEGRAM_BOT_TOKEN goto setup
if /i "%TELEGRAM_BOT_TOKEN%"=="PASTE_YOUR_TELEGRAM_TOKEN_HERE" goto setup
goto install

:setup
echo First-time setup: paste your Telegram BotFather token below.
set /p "TELEGRAM_BOT_TOKEN=Telegram token: "
if not defined TELEGRAM_BOT_TOKEN (
  echo No token was entered.
  pause
  exit /b 1
)
echo.
set /p "GEMINI_API_KEY=Optional Gemini key (press Enter to skip): "
if not defined GEMINI_MODEL set "GEMINI_MODEL=gemini-2.5-flash"
if not defined SPORTYBET_REGION set "SPORTYBET_REGION=ng"
(
  echo TELEGRAM_BOT_TOKEN=%TELEGRAM_BOT_TOKEN%
  echo GEMINI_API_KEY=%GEMINI_API_KEY%
  echo GEMINI_MODEL=%GEMINI_MODEL%
  echo SPORTYBET_REGION=%SPORTYBET_REGION%
)> .env

echo Settings saved. Starting the bot.

:install
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
echo.
echo Starting the Telegram bot. Keep this window open.
call npm.cmd run bot
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo The bot could not start. Read the error above.
pause
exit /b 1
