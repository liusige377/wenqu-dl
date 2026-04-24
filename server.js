/**
 * 问渠下载器 - 轻量版后台服务
 * 纯Node.js，无Electron依赖
 * HTTP API (15888) + 管理界面静态服务 (15889)
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const crypto = require('crypto');
const DownloadEngine = require('./src/downloader');
const LicenseManager = require('./src/license');

// ========== 配置 ==========
const API_PORT = 15888;        // 浏览器扩展通信端口
const WEB_PORT = 15889;        // 管理界面端口
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'WenQuDownloader');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ========== 初始化 ==========
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(path.join(DATA_DIR, 'downloads'));

const engine = new DownloadEngine({ maxConnections: 32, concurrency: 16, speedLimit: 0, maxConcurrent: 3 });
const license = new LicenseManager();

// 加载保存的配置
loadConfig();

// ========== 默认下载路径 ==========
function getDefaultPath() {
  const cfg = loadConfig();
  return cfg.defaultPath || path.join(os.homedir(), 'Downloads', '问渠下载器');
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return fs.readJsonSync(CONFIG_FILE);
    }
  } catch (e) {}
  return {};
}

function saveConfigFile(cfg) {
  try {
    fs.writeJsonSync(CONFIG_FILE, cfg, { spaces: 2 });
  } catch (e) {
    console.error('保存配置失败:', e);
  }
}

// ========== SSE 客户端管理（实时推送） ==========
const sseClients = new Set();

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try { client.res.write(msg); } catch (e) { sseClients.delete(client); }
  });
}

// ========== 下载引擎事件 → SSE推送 ==========
engine.on('progress', (task) => {
  broadcastSSE('progress', {
    id: task.id, downloaded: task.downloaded, totalSize: task.totalSize,
    progress: task.progress, speed: task.speed, status: task.status
  });
});

engine.on('completed', (task) => {
  broadcastSSE('completed', {
    id: task.id, filename: task.filename, filePath: task.filePath,
    totalSize: task.totalSize, status: 'completed'
  });
  console.log(`✅ 下载完成: ${task.filename}`);
});

engine.on('error', (task, err) => {
  broadcastSSE('error', { id: task.id, error: err.message, status: 'error' });
  console.error(`❌ 下载失败: ${task.filename} - ${err.message}`);
});

engine.on('paused', (task) => {
  broadcastSSE('paused', { id: task.id, status: 'paused' });
});

engine.on('started', (task) => {
  broadcastSSE('started', { id: task.id, filename: task.filename, status: 'downloading' });
});

// ========== API 服务器 (15888) — 浏览器扩展通信 ==========
const apiServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const route = parsedUrl.pathname;

  try {
    // === 状态检查 ===
    if (route === '/status' && req.method === 'GET') {
      const licenseStatus = license.getStatus();
      jsonRes(res, 200, {
        running: true, version: '3.0.0',
        license: licenseStatus,
        activeDownloads: engine.activeDownloads.size,
        queuedDownloads: engine.queue.length
      });
    }
    // === SSE 实时推送 ===
    else if (route === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      const clientId = crypto.randomBytes(8).toString('hex');
      sseClients.add({ id: clientId, res });
      res.write(`event: connected\ndata: {"id":"${clientId}"}\n\n`);
      req.on('close', () => sseClients.delete({ id: clientId, res }));
    }
    // === 添加下载 ===
    else if (route === '/download' && req.method === 'POST') {
      const body = await readBody(req);
      const { url: downloadUrl, filename, savePath, headers, referer } = JSON.parse(body);

      if (!downloadUrl) { jsonRes(res, 400, { error: '缺少下载地址' }); return; }

      // 检查授权
      if (license.needsActivation()) {
        const status = license.getStatus();
        if (status.status === 'trial_expired') {
          jsonRes(res, 403, { error: '试用已过期，请购买授权', needActivation: true });
          return;
        }
        // 试用期间限制：免费版单线程，专业版多线程
      }

      try {
        const task = await engine.createDownload(
          downloadUrl,
          savePath || getDefaultPath(),
          { headers: { Referer: referer || '', ...headers } }
        );
        engine.start(task.id);
        jsonRes(res, 200, {
          success: true, taskId: task.id,
          filename: task.filename, size: task.totalSize, category: task.category
        });
        console.log(`📥 开始下载: ${task.filename} (${formatSize(task.totalSize)})`);
      } catch (err) {
        jsonRes(res, 500, { error: err.message });
      }
    }
    // === 暂停下载 ===
    else if (route === '/pause' && req.method === 'POST') {
      const body = await readBody(req);
      const { taskId } = JSON.parse(body);
      const task = engine.pause(taskId);
      jsonRes(res, 200, { success: true, task: formatTask(task) });
    }
    // === 恢复下载 ===
    else if (route === '/resume' && req.method === 'POST') {
      const body = await readBody(req);
      const { taskId } = JSON.parse(body);
      const task = await engine.resume(taskId);
      jsonRes(res, 200, { success: true, task: formatTask(task) });
    }
    // === 取消下载 ===
    else if (route === '/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const { taskId } = JSON.parse(body);
      await engine.cancel(taskId);
      jsonRes(res, 200, { success: true });
    }
    // === 删除记录 ===
    else if (route === '/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const { taskId, deleteFile } = JSON.parse(body);
      engine.remove(taskId, deleteFile);
      jsonRes(res, 200, { success: true });
    }
    // === 暂停所有 ===
    else if (route === '/pause-all' && req.method === 'POST') {
      engine.getAll().forEach(t => { if (t.status === 'downloading') engine.pause(t.id); });
      jsonRes(res, 200, { success: true });
    }
    // === 恢复所有 ===
    else if (route === '/resume-all' && req.method === 'POST') {
      engine.getAll().forEach(t => { if (t.status === 'paused') engine.resume(t.id); });
      jsonRes(res, 200, { success: true });
    }
    // === 任务列表 ===
    else if (route === '/tasks' && req.method === 'GET') {
      const tasks = engine.getAll().map(formatTask);
      jsonRes(res, 200, { tasks });
    }
    // === 视频嗅探结果 ===
    else if (route === '/sniff' && req.method === 'POST') {
      const body = await readBody(req);
      broadcastSSE('sniff_result', JSON.parse(body));
      jsonRes(res, 200, { success: true });
    }
    // === 获取配置 ===
    else if (route === '/config' && req.method === 'GET') {
      const cfg = loadConfig();
      jsonRes(res, 200, {
        maxConnections: engine.maxConnections,
        speedLimit: engine.speedLimit,
        maxConcurrent: engine.maxConcurrent,
        proxy: engine.proxy,
        defaultPath: cfg.defaultPath || getDefaultPath()
      });
    }
    // === 保存配置 ===
    else if (route === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = JSON.parse(body);
      if (cfg.maxConnections) engine.setMaxConnections(cfg.maxConnections);
      if (cfg.speedLimit !== undefined) engine.setSpeedLimit(cfg.speedLimit);
      if (cfg.maxConcurrent) engine.maxConcurrent = cfg.maxConcurrent;
      if (cfg.proxy !== undefined) engine.proxy = cfg.proxy;
      saveConfigFile({ ...loadConfig(), ...cfg });
      jsonRes(res, 200, { success: true });
    }
    // === 授权状态 ===
    else if (route === '/license/status' && req.method === 'GET') {
      jsonRes(res, 200, license.getStatus());
    }
    // === 激活授权 ===
    else if (route === '/license/activate' && req.method === 'POST') {
      const body = await readBody(req);
      const { key } = JSON.parse(body);
      const result = await license.activate(key);
      jsonRes(res, 200, result);
    }
    // === 注销授权 ===
    else if (route === '/license/deactivate' && req.method === 'POST') {
      const result = license.deactivate();
      jsonRes(res, 200, result);
    }
    // === 生成授权码（管理员） ===
    else if (route === '/license/generate' && req.method === 'POST') {
      const body = await readBody(req);
      const { type, count } = JSON.parse(body);
      const keys = LicenseManager.generateBatch(type || 'yearly', count || 1);
      jsonRes(res, 200, { keys });
    }
    // === 选择目录（返回默认路径） ===
    else if (route === '/default-path' && req.method === 'GET') {
      jsonRes(res, 200, { path: getDefaultPath() });
    }
    // === m3u8/HLS 流媒体下载 ===
    else if (route === '/download/m3u8' && req.method === 'POST') {
      const body = await readBody(req);
      const { url: m3u8Url, savePath, headers, referer, filename } = JSON.parse(body);
      if (!m3u8Url) { jsonRes(res, 400, { error: '缺少m3u8地址' }); return; }
      try {
        const task = await engine.downloadM3U8(m3u8Url, savePath || getDefaultPath(), {
          headers: { Referer: referer || '', ...headers },
          filename: filename || ''
        });
        jsonRes(res, 200, {
          success: true, taskId: task.id,
          filename: task.filename, segments: task.segments?.length || 0,
          isM3U8: true
        });
        console.log(`🎬 开始M3U8下载: ${task.filename} (${task.segments?.length || 0}个片段)`);
      } catch (err) {
        jsonRes(res, 500, { error: err.message });
      }
    }
    // === 嗅探页面视频 ===
    else if (route === '/sniff-page' && req.method === 'POST') {
      const body = await readBody(req);
      const { pageUrl } = JSON.parse(body);
      // 返回已嗅探的视频信息
      jsonRes(res, 200, { success: true, message: '请使用浏览器扩展嗅探页面视频' });
    }
    else {
      jsonRes(res, 404, { error: '未知接口' });
    }
  } catch (err) {
    console.error('API错误:', err);
    jsonRes(res, 500, { error: err.message });
  }
});

apiServer.listen(API_PORT, '127.0.0.1', () => {
  console.log(`🦞 问渠下载器 API: http://127.0.0.1:${API_PORT}`);
});

// ========== 管理界面服务器 (15889) — 本地网页 ==========
const webDir = path.join(__dirname, 'web');

const webServer = http.createServer((req, res) => {
  let filePath = path.join(webDir, url.parse(req.url).pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(webDir, 'index.html');
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
  };

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

webServer.listen(WEB_PORT, '127.0.0.1', () => {
  console.log(`🦞 管理界面: http://127.0.0.1:${WEB_PORT}`);
});

// ========== 辅助函数 ==========
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function formatTask(t) {
  return {
    id: t.id, url: t.url, filename: t.filename, filePath: t.filePath,
    totalSize: t.totalSize, downloaded: t.downloaded, progress: t.progress,
    speed: t.speed, status: t.status, category: t.category, resumable: t.resumable,
    connections: t.chunks ? t.chunks.length : 0, createdAt: t.createdAt,
    startTime: t.startTime, endTime: t.endTime, error: t.error || null
  };
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

// ========== 优雅退出 ==========
process.on('SIGINT', () => {
  console.log('\n🦞 问渠下载器正在关闭...');
  apiServer.close();
  webServer.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('未捕获异常:', err);
});

// ========== 启动信息 ==========
console.log('╔══════════════════════════════════════════╗');
console.log('║  🦞 问渠下载器 v3.0 - IDM级分片队列    ║');
console.log('║  引擎: 分片队列调度 + 令牌桶限速        ║');
console.log('║  API: http://127.0.0.1:15888             ║');
console.log('║  管理: http://127.0.0.1:15889            ║');
console.log('║  成都鑫腾飞气体 · wenquso.cn             ║');
console.log('║  客服: 180-8048-8989 / a龙虾             ║');
console.log('╚══════════════════════════════════════════╝');
