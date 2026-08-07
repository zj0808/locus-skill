@echo off
pwsh -NoProfile -File "%~dp0scripts\ace.ps1" %*
exit /b %ERRORLEVEL%
