@echo off
chcp 65001 >nul
title 问渠下载器一键安装
cls

echo ========================================
echo    问渠下载器 v3.0.2 一键安装程序
echo ========================================
echo.

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [提示] 需要管理员权限，正在提升...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "INSTALL_DIR=%LOCALAPPDATA%\WenQuDownloader"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo [1/6] 正在创建安装目录...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%INSTALL_DIR%\downloads" mkdir "%INSTALL_DIR%\downloads"

echo [2/6] 正在复制文件...
xcopy /E /Y /Q "%~dp0*" "%INSTALL_DIR%\" >nul 2>&1

echo [3/6] 正在安装依赖...
cd /d "%INSTALL_DIR%"
call npm install --production --silent
if %errorlevel% neq 0 (
    echo [错误] npm install 失败，请确保已安装 Node.js
    pause
    exit /b 1
)

echo [4/6] 正在配置防火墙...
netsh advfirewall firewall add rule name="WenQuDownloader API" dir=in action=allow protocol=tcp localport=15888 >nul 2>&1
netsh advfirewall firewall add rule name="WenQuDownloader Web" dir=in action=allow protocol=tcp localport=15889 >nul 2>&1

echo [5/6] 正在创建快捷方式...
powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\问渠下载器.lnk'); $Shortcut.TargetPath = '%INSTALL_DIR%\start.vbs'; $Shortcut.WorkingDirectory = '%INSTALL_DIR%'; $Shortcut.IconLocation = '%INSTALL_DIR%\icons\icon.ico'; $Shortcut.Save()" >nul 2>&1

echo [6/6] 正在配置开机自启...
copy /Y "%INSTALL_DIR%\start.vbs" "%STARTUP_DIR%\WenQuDownloader.vbs" >nul 2>&1

echo.
echo ========================================
echo    安装完成！
echo ========================================
echo.
echo 安装路径: %INSTALL_DIR%
echo 桌面快捷方式已创建
echo 开机自启已配置
echo.
echo 正在启动问渠下载器...
timeout /t 2 /nobreak >nul
start "" "%INSTALL_DIR%\start.vbs"
start "" "http://127.0.0.1:15889"

echo.
echo 按任意键退出...
pause >nul
