/**
 * 问渠下载器 - 打包脚本
 * 将 Node.js 应用打包成可分发的安装包
 * 用法: node build.js
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const SRC = __dirname;

async function build() {
  console.log('🦞 问渠下载器 - 开始打包...\n');

  // 1. 清理dist目录
  console.log('[1/6] 清理输出目录...');
  fs.removeSync(DIST);
  fs.ensureDirSync(DIST);

  // 2. 复制 Node.js 运行时
  console.log('[2/6] 复制 Node.js 运行时...');
  const nodeExe = process.execPath;
  fs.copySync(nodeExe, path.join(DIST, 'node.exe'));
  console.log(`   Node.js: ${nodeExe}`);

  // 3. 复制核心代码
  console.log('[3/6] 复制核心代码...');
  fs.copySync(path.join(SRC, 'server.js'), path.join(DIST, 'server.js'));
  fs.copySync(path.join(SRC, 'package.json'), path.join(DIST, 'package.json'));
  fs.copySync(path.join(SRC, 'src'), path.join(DIST, 'src'));

  // 复制精简的 node_modules
  console.log('[4/6] 复制依赖包...');
  fs.ensureDirSync(path.join(DIST, 'node_modules'));
  const deps = ['got', 'fs-extra', 'mime-types', 'uuid', 'node-machine-id',
    'cors', 'express', 'body-parser', 'content-disposition', 'cookie',
    'debug', 'iconv-lite', 'raw-body', 'qs', 'vary', 'etag', 'fresh',
    'mime-db', 'negotiator', 'parseurl', 'send', 'serve-static', 'accepts',
    'http-errors', 'on-finished', 'setprototypeof', 'statuses', 'toidentifier',
    'unpipe', 'depd', 'bytes', 'safe-buffer', 'inherits', 'unshift',
    // got dependencies
    '@sindresorhus/is', '@szmarczak/http-timer', 'cacheable-lookup',
    'cacheable-request', 'clone-response', 'decompress-response',
    'defer-to-connect', 'get-stream', 'http-cache-semantics', 'http2-wrapper',
    'keyv', 'lowercase-keys', 'mimic-response', 'normalize-url',
    'p-cancelable', 'quick-lru', 'resolve-alpn', 'responselike',
    // uuid dependencies
    // fs-extra dependencies
    'jsonfile', 'universalify', 'graceful-fs',
    // node-machine-id
    // others
    'end-of-stream', 'once', 'wrappy', 'pump',
    'get-intrinsic', 'has-symbols', 'hasown', 'call-bind-apply-helpers',
    'call-bound', 'dunder-proto', 'es-define-property', 'es-errors',
    'es-object-atoms', 'function-bind', 'gopd', 'math-intrinsics',
    'object-inspect', 'side-channel', 'side-channel-list',
    'side-channel-map', 'side-channel-weakmap', 'safe-buffer',
    'safer-buffer', 'router', 'path-to-regexp', 'range-parser',
    'type-is', 'proxy-addr', 'ipaddr.js', 'forwarded',
    'progress'
  ];
  
  deps.forEach(dep => {
    const src = path.join(SRC, 'node_modules', dep);
    const dst = path.join(DIST, 'node_modules', dep);
    if (fs.existsSync(src)) {
      try { fs.copySync(src, dst); } catch(e) { console.log(`   跳过: ${dep}`); }
    }
  });
  
  // Also copy @types if needed
  const atTypes = path.join(SRC, 'node_modules', '@types');
  if (fs.existsSync(atTypes)) {
    // Skip @types - not needed at runtime
  }

  // 5. 复制资源文件
  console.log('[5/6] 复制资源文件...');
  const resourcesDir = path.join(DIST, 'resources');
  fs.ensureDirSync(resourcesDir);
  fs.copySync(path.join(SRC, 'web'), path.join(resourcesDir, 'web'));
  fs.copySync(path.join(SRC, 'extension'), path.join(resourcesDir, 'extension'));

  // 复制安装脚本
  fs.copySync(path.join(SRC, 'install.bat'), path.join(DIST, 'install.bat'));

  // 创建VBS隐藏启动脚本（不弹控制台窗口）
  // VBS调PowerShell隐藏启动Node.js
  const startVbs = 'CreateObject("WScript.Shell").Run "powershell -WindowStyle Hidden -Command ""Start-Process -FilePath \""" & Replace(WScript.ScriptFullName, WScript.ScriptName, "") & "node.exe\""" -ArgumentList \"""" & Replace(WScript.ScriptFullName, WScript.ScriptName, "") & "server.js\""" -WindowStyle Hidden""", 0, False';
  // 太复杂了，用简单方案
  const simpleVbs = `Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ws.Run "node.exe server.js", 0, False
`;
  fs.writeFileSync(path.join(DIST, 'start.vbs'), simpleVbs, 'ascii');

  // 创建手动启动脚本（调试用，有控制台窗口）
  const startBat = `@echo off
cd /d "%~dp0"
start "" /MIN "%~dp0node.exe" "%~dp0server.js"
timeout /t 3 >nul
start http://127.0.0.1:15889
`;
  fs.writeFileSync(path.join(DIST, 'start.bat'), startBat, 'utf8');

  // 创建卸载脚本
  const uninstallBat = `@echo off
chcp 65001 >nul
title 问渠下载器 - 卸载
echo 正在停止问渠下载器...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *server.js*" >nul 2>&1
echo 正在移除开机自启动...
reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "WenQuDownloader" /f >nul 2>&1
del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\问渠下载器.lnk" >nul 2>&1
echo 正在删除文件...
cd /d "%~dp0"
cd ..
rd /s /q "%~dp0"
echo 卸载完成！
pause
`;
  fs.writeFileSync(path.join(DIST, '卸载.bat'), uninstallBat, 'utf8');

  // 创建版本信息
  fs.writeJsonSync(path.join(DIST, 'version.json'), {
    name: '问渠下载器',
    version: '3.0.0',
    buildDate: new Date().toISOString(),
    author: '成都鑫腾飞气体有限公司',
    website: 'https://wenquso.cn',
    contact: '180-8048-8989'
  }, { spaces: 2 });

  // 6. 统计
  console.log('[6/6] 统计...');
  const size = getDirSize(DIST);
  console.log(`\n✅ 打包完成！输出目录: ${DIST}`);
  console.log(`📦 总大小: ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log('\n分发步骤:');
  console.log('  1. 将 dist 目录压缩成 ZIP');
  console.log('  2. 重命名为: 问渠下载器_v1.0.zip');
  console.log('  3. 上传到 wenquso.cn 供用户下载');
  console.log('  4. 用户解压后右键"以管理员身份运行" install.bat');
}

function getDirSize(dir) {
  let size = 0;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += stat.size;
      }
    }
  } catch(e) {}
  return size;
}

build().catch(err => {
  console.error('打包失败:', err);
  process.exit(1);
});
