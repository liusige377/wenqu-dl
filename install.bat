@echo off
chcp 65001 >nul
title WenQu Downloader v3.0 - Installer
echo ========================================
echo   WenQu Downloader v3.0 - Installer
echo   IDM-level chunk queue / 32 threads / resume
echo   Chengdu Xintengfei Gas / wenquso.cn
echo ========================================
echo.

set "INSTALL_DIR=%ProgramFiles%\WenQuDownloader"

echo [1/7] Creating install directory...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

echo [2/7] Copying files...
xcopy /E /Y /Q "%~dp0*" "%INSTALL_DIR%\" >nul 2>&1
if errorlevel 1 (
    echo [!] Copy failed. Please right-click and "Run as administrator"
    pause
    exit /b 1
)

echo [3/7] Configuring firewall...
netsh advfirewall firewall add rule name="WenQuAPI" dir=in action=allow protocol=TCP localport=15888 >nul 2>&1
netsh advfirewall firewall add rule name="WenQuWeb" dir=in action=allow protocol=TCP localport=15889 >nul 2>&1

echo [4/7] Creating desktop shortcut...
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\WenQuDownloader.lnk'); $s.TargetPath = 'http://127.0.0.1:15889'; $s.Save()"

echo [5/7] Configuring auto-start (silent)...
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Startup') + '\WenQuDownloader.lnk'); $s.TargetPath = '%INSTALL_DIR%\start.vbs'; $s.WindowStyle = 7; $s.Save()"

echo [6/7] Writing registry auto-start (backup)...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "WenQuDownloader" /t REG_SZ /d "wscript.exe \"%INSTALL_DIR%\start.vbs\"" /f >nul 2>&1

echo [7/7] Starting WenQu Downloader...
wscript "%INSTALL_DIR%\start.vbs"
timeout /t 3 >nul

echo.
echo ========================================
echo   Installation complete!
echo ========================================
echo.
echo   API:  http://127.0.0.1:15888
echo   Web:  http://127.0.0.1:15889
echo   Auto-start configured (silent background)
echo.
echo   Browser Extension Install:
echo   1. Open Chrome/Edge
echo   2. Go to chrome://extensions (or edge://extensions)
echo   3. Enable "Developer mode"
echo   4. Click "Load unpacked"
echo   5. Select: %INSTALL_DIR%\resources\extension
echo   6. Done!
echo.
start http://127.0.0.1:15889
pause
