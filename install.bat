@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

echo ========================================
echo   WenQu Downloader v3.0 - Installer
echo   多线程加速  ^|  断点续传  ^|  视频嗅探
echo ========================================
echo.

:: ===== 检测管理员权限 =====
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] 请右键选择"以管理员身份运行"此安装程序
    echo    （需要管理员权限来配置防火墙和浏览器扩展）
    pause
    exit /b 1
)

set "INSTALL_DIR=%ProgramFiles%\WenQuDownloader"
set "EXT_PATH=%INSTALL_DIR%\resources\extension"

:: ===== 1. 创建目录 =====
echo [1/8] 创建安装目录...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
echo     OK

:: ===== 2. 复制文件 =====
echo [2/8] 复制程序文件...
xcopy /E /Y /Q "%~dp0*" "%INSTALL_DIR%\" >nul 2>&1
if errorlevel 1 (
    echo [!] 文件复制失败，请检查磁盘空间和权限
    pause
    exit /b 1
)
echo     OK

:: ===== 3. 安装依赖 =====
echo [3/8] 安装依赖（npm install）...
cd /d "%INSTALL_DIR%"
if exist package.json (
    call npm install --silent --no-audit --no-fund >nul 2>&1
    if errorlevel 1 (
        echo [!] npm install 失败，请检查网络连接
        pause
        exit /b 1
    )
    echo     OK
) else (
    echo     (跳过，无package.json)
)

:: ===== 4. 防火墙 =====
echo [4/8] 配置防火墙...
netsh advfirewall firewall add rule name="WenQuAPI" dir=in action=allow protocol=TCP localport=15888 >nul 2>&1
netsh advfirewall firewall add rule name="WenQuWeb" dir=in action=allow protocol=TCP localport=15889 >nul 2>&1
echo     OK

:: ===== 5. 注册浏览器扩展（Chrome Policy）=====
echo [5/8] 配置浏览器扩展（自动加载）...

:: Chrome - ExtensionInstallForcelist (企业模式强制安装)
reg add "HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "1;%EXT_PATH%" /f >nul 2>&1
reg add "HKCU\SOFTWARE\Google\Chrome\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "1;%EXT_PATH%" /f >nul 2>&1

:: Edge - ExtensionInstallForcelist
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "1;%EXT_PATH%" /f >nul 2>&1
reg add "HKCU\SOFTWARE\Microsoft\Edge\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "1;%EXT_PATH%" /f >nul 2>&1

:: 360安全浏览器
reg add "HKLM\SOFTWARE\360Safe\Chrome\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "1;%EXT_PATH%" /f >nul 2>&1
reg add "HKCU\SOFTWARE\360Safe\Chrome\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "1;%EXT_PATH%" /f >nul 2>&1

echo     OK（浏览器重启后生效）

:: ===== 6. 桌面快捷方式 =====
echo [6/8] 创建桌面快捷方式...
:: 默认用vbs无黑框启动
powershell -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\WenQuDownloader.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='""%INSTALL_DIR%\start.vbs""'; $s.WorkingDirectory='%INSTALL_DIR%'; $s.Description='问渠下载器'; $s.Save()"
echo     OK

:: ===== 7. 开机自启 =====
echo [7/8] 配置开机自启...
:: 使用vbs静默启动，无黑框
powershell -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut([Environment]::GetFolderPath('Startup')+'\WenQuDownloader.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='""%INSTALL_DIR%\start.vbs""'; $s.WindowStyle=7; $s.Save()"
echo     OK

:: ===== 8. 启动服务 =====
echo [8/8] 启动服务...
start "" /b cmd /c "cd /d "%INSTALL_DIR%" && start.bat"
echo     OK

:: ===== 验证 =====
timeout /t 2 >nul
curl -s --connect-timeout 3 "http://127.0.0.1:15888/api/status" >nul 2>&1
if %errorlevel% equ 0 (
    set "STATUS=运行中"
) else (
    set "STATUS=启动中（请稍后刷新）"
)

:: ===== 完成提示 =====
cls
echo.
echo  ========================================
echo    安装完成！
echo  ========================================
echo.
echo  管理界面: http://127.0.0.1:15889
echo  状态: !STATUS!
echo.
echo  浏览器扩展已配置:
echo   - Chrome: 重启浏览器后自动生效
echo   - Edge:   重启浏览器后自动生效
echo   - 360安全浏览器: 重启后自动生效
echo.
echo  如需手动开启扩展:
echo   1. 打开浏览器设置
echo   2. 找到"扩展程序"
echo   3. 开启"开发者模式"
echo   4. 点击"加载解包的扩展"
echo   5. 选择: %INSTALL_DIR%\resources\extension
echo.
echo  提示: 右键桌面"问渠下载器"打开管理界面
echo.
echo  按任意键打开管理界面...
pause >nul
start "" "http://127.0.0.1:15889"