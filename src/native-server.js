/**
 * 问渠下载器 - Native Messaging Host
 * 浏览器扩展通过此服务与桌面端通信
 * 监听 127.0.0.1:15888
 */

const http = require('http');
const url = require('url');
const crypto = require('crypto');

class NativeServer {
  constructor(downloadEngine, licenseManager, port = 15888) {
    this.engine = downloadEngine;
    this.license = licenseManager;
    this.port = port;
    this.server = null;
    this.clients = new Set();
    this.authToken = crypto.randomBytes(32).toString('hex');
  }

  /**
   * 启动服务器
   */
  start() {
    this.server = http.createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const parsedUrl = url.parse(req.url, true);
      const route = parsedUrl.pathname;

      try {
        // 路由分发
        if (route === '/status') {
          this._handleStatus(req, res);
        } else if (route === '/download') {
          await this._handleDownload(req, res);
        } else if (route === '/pause') {
          await this._handlePause(req, res);
        } else if (route === '/resume') {
          await this._handleResume(req, res);
        } else if (route === '/cancel') {
          await this._handleCancel(req, res);
        } else if (route === '/tasks') {
          this._handleTasks(req, res);
        } else if (route === '/sniff') {
          this._handleSniff(req, res);
        } else if (route === '/config') {
          this._handleConfig(req, res);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未知接口' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`问渠下载器 Native Server 启动: http://127.0.0.1:${this.port}`);
    });

    return this.authToken;
  }

  /**
   * 状态检查
   */
  _handleStatus(req, res) {
    const licenseStatus = this.license.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: true,
      version: '1.0.0',
      license: licenseStatus,
      activeDownloads: this.engine.activeDownloads.size,
      queuedDownloads: this.engine.queue.length
    }));
  }

  /**
   * 添加下载任务
   */
  async _handleDownload(req, res) {
    const body = await this._readBody(req);
    const { url: downloadUrl, filename, savePath, headers, referer } = JSON.parse(body);

    if (!downloadUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少下载地址' }));
      return;
    }

    try {
      const task = await this.engine.createDownload(
        downloadUrl,
        savePath || this._getDefaultPath(),
        { headers: { Referer: referer || '', ...headers } }
      );

      // 自动开始下载
      this.engine.start(task.id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        taskId: task.id,
        filename: task.filename,
        size: task.totalSize,
        category: task.category
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  /**
   * 暂停下载
   */
  async _handlePause(req, res) {
    const body = await this._readBody(req);
    const { taskId } = JSON.parse(body);
    const task = this.engine.pause(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, task }));
  }

  /**
   * 恢复下载
   */
  async _handleResume(req, res) {
    const body = await this._readBody(req);
    const { taskId } = JSON.parse(body);
    const task = await this.engine.resume(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, task }));
  }

  /**
   * 取消下载
   */
  async _handleCancel(req, res) {
    const body = await this._readBody(req);
    const { taskId } = JSON.parse(body);
    await this.engine.cancel(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * 获取任务列表
   */
  _handleTasks(req, res) {
    const tasks = this.engine.getAll().map(t => ({
      id: t.id,
      filename: t.filename,
      size: t.totalSize,
      downloaded: t.downloaded,
      progress: t.progress,
      speed: t.speed,
      status: t.status,
      category: t.category,
      createdAt: t.createdAt
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks }));
  }

  /**
   * 视频嗅探结果接收
   */
  _handleSniff(req, res) {
    // 接收浏览器扩展嗅探到的视频/音频URL
    const body = this._readBody(req);
    // 广播给所有连接的客户端
    this._broadcast({ type: 'sniff_result', data: body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * 配置
   */
  _handleConfig(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      maxConnections: this.engine.maxConnections,
      speedLimit: this.engine.speedLimit,
      maxConcurrent: this.engine.maxConcurrent,
      proxy: this.engine.proxy
    }));
  }

  /**
   * 读取请求体
   */
  _readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
    });
  }

  /**
   * 获取默认下载路径
   */
  _getDefaultPath() {
    const os = require('os');
    return path.join(os.homedir(), 'Downloads', '问渠下载器');
  }

  /**
   * 广播消息
   */
  _broadcast(data) {
    const msg = JSON.stringify(data);
    this.clients.forEach(client => {
      try { client.write(`data: ${msg}\n\n`); } catch (e) {}
    });
  }

  /**
   * 停止服务器
   */
  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = NativeServer;
