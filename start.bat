@echo off
chcp 65001 >nul 2>&1
:: 问渠下载器 v3.0 - 控制台启动脚本（双击运行/调试用）
:: 静默启动请使用 start.vbs（无黑框）
cd /d "%~dp0"

:: 检测 node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   ╔══════════════════════════════════════╗
    echo   ║  ⚠️  未检测到 Node.js 运行环境        ║
    echo   ╠══════════════════════════════════════╣
    echo   ║  请安装 Node.js 后重新运行：          ║
    echo   ║  https://nodejs.org/zh-cn/download/   ║
    echo   ╚══════════════════════════════════════╝
    echo.
    start "" "https://nodejs.org/zh-cn/download/"
    pause
    exit /b 1
)

echo ========================================
echo   🦞 问渠下载器 v3.0 - 启动中...
echo   按 Ctrl+C 可停止服务
echo ========================================
node server.js
