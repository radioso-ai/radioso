@echo off
setlocal
node "%~dp0scripts\run-dev.mjs" %*
exit /b %errorlevel%
