@echo off
rem kons sunucusunu baslatir ve paneli tarayicida acar.
cd /d "%~dp0"
start "" http://127.0.0.1:4700
node --disable-warning=ExperimentalWarning server.js
pause
