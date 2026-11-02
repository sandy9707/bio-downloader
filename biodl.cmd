@echo off
setlocal
chcp 65001 >nul
set "ELECTRON_RUN_AS_NODE=1"
set "BIODL_HEADLESS=1"
if not defined BIODL_DATA_DIR set "BIODL_DATA_DIR=%APPDATA%\bio-downloader-cli"
"%~dp0BioDownloader.exe" "%~dp0resources\app.asar\packages\cli\bin.js" %*
exit /b %errorlevel%
