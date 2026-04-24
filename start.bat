@echo off
:: 问渠下载器 v3.0 - 后台启动脚本
:: 被任务计划程序调用，或手动运行
cd /d "%~dp0"
start "" /MIN node server.js
