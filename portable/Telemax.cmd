@echo off
rem Telemax portable for Windows. Starts the tray icon (app\tray.ps1); the icon starts the bridge,
rem watches the connection and opens the settings page. Nothing is installed: delete the folder
rem to remove it. Keep this file ASCII-only - cmd.exe reads it in the console code page.
if not exist "%~dp0app\node.exe" (
  echo app\node.exe not found. Unpack the WHOLE archive into a folder and start Telemax.cmd from there.
  pause
  exit /b 1
)
rem conhost --headless: no console window at all (a plain "powershell -WindowStyle Hidden" flashes one,
rem and under Windows Terminal leaves it on the taskbar).
start "" conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\tray.ps1"
