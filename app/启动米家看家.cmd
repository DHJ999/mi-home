@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 米家看家
node server.mjs
if errorlevel 1 pause
