/**
 * 问渠下载器 - 多线程分片下载引擎 v3.0
 * 
 * v3.0 核心改进（深度借鉴IDM）：
 * 1. 分片队列调度：文件切成多个小分片，线程从队列取，快线程自然下载更多
 *    - IDM的核心秘诀：不是固定分片，而是分片队列 + 工作线程
 *    - 快线程完成一个分片后立即取下一个，自动负载均衡
 * 2. 令牌桶限速：平滑限速，替代粗暴pause/resume
 * 3. 加密HLS解密：支持AES-128加密的TS片段
 * 4. 更强的容错：自动降线程、智能重试、卡死检测
 */

const got = require('got');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

// ========== 令牌桶限速 ==========
class TokenBucket {
  constructor(bytesPerSecond) {
    this.rate = bytesPerSecond;
    this.tokens = bytesPerSecond; // 初始满桶
    this.lastRefill = Date.now();
    this.maxBurst = bytesPerSecond * 2; // 允许2秒突发
  }

  consume(bytes) {
    if (this.rate <= 0) return 0; // 无限速
    this._refill();
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return 0;
    }
    const waitMs = ((bytes - this.tokens) / this.rate) * 1000;
    this.tokens = 0;
    return waitMs;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxBurst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  setRate(bytesPerSecond) {
    this.rate = bytesPerSecond;
    this.maxBurst = bytesPerSecond * 2;
  }
}

class DownloadEngine {
  constructor(options = {}) {
    this.maxConnections = options.maxConnections || 32;
    this.concurrency = options.concurrency || 16;     // 最大同时下载的分片数
    this.speedLimit = options.speedLimit || 0;         // 0 = 无限速
    this.userAgent = options.userAgent || 'WenQuDownloader/3.0';
    this.proxy = options.proxy || null;
    this.timeout = options.timeout || 30000;
    this.activeDownloads = new Map();
    this.queue = [];
    this.maxConcurrent = options.maxConcurrent || 3;
    this.running = 0;
    this._bucket = new TokenBucket(this.speedLimit);
    this._failureWindow = {};
  }

  // ========== 分析远程文件 ==========
  async analyze(url, headers = {}) {
    try {
      const reqHeaders = { 'User-Agent': this.userAgent, ...headers };
      const response = await got.head(url, {
        headers: reqHeaders,
        timeout: { request: this.timeout },
        followRedirect: true, maxRedirects: 10,
        ...(this.proxy ? { proxy: this.proxy } : {})
      });

      const contentLength = parseInt(response.headers['content-length'] || '0');
      const acceptRanges = response.headers['accept-ranges'];
      const contentType = response.headers['content-type'] || '';
      const contentDisposition = response.headers['content-disposition'] || '';
      const etag = response.headers['etag'] || '';
      const lastModified = response.headers['last-modified'] || '';

      let filename = '';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^;"'\n]+)/i);
        if (match) filename = decodeURIComponent(match[1]);
      }
      if (!filename) filename = path.basename(new URL(url).pathname) || 'download';
      if (!path.extname(filename) && contentType) {
        const ext = mime.extension(contentType.split(';')[0]);
        if (ext) filename += '.' + ext;
      }

      return {
        url, filename, size: contentLength,
        resumable: acceptRanges === 'bytes',
        contentType, etag, lastModified,
        supportsMultiThread: acceptRanges === 'bytes' && contentLength > 2 * 1024 * 1024
      };
    } catch (err) {
      // HEAD失败尝试GET
      try {
        const response = await got(url, {
          headers: { 'User-Agent': this.userAgent, ...headers },
          timeout: { request: this.timeout },
          followRedirect: true, maxRedirects: 10,
          ...(this.proxy ? { proxy: this.proxy } : {})
        });
        return {
          url, filename: path.basename(new URL(url).pathname) || 'download',
          size: parseInt(response.headers['content-length'] || '0'),
          resumable: false, contentType: response.headers['content-type'] || '',
          supportsMultiThread: false
        };
      } catch (err2) {
        throw new Error(`无法访问下载地址: ${err2.message}`);
      }
    }
  }

  // ========== 创建下载任务 ==========
  async createDownload(url, savePath, options = {}) {
    const id = uuidv4();
    const info = await this.analyze(url, options.headers);
    const filePath = path.join(savePath, info.filename);

    const task = {
      id, url, filename: info.filename, filePath,
      totalSize: info.size, downloaded: 0, speed: 0, progress: 0,
      status: 'waiting',
      resumable: info.resumable,
      supportsMultiThread: info.supportsMultiThread,
      connections: [], chunks: [],
      etag: info.etag, lastModified: info.lastModified,
      contentType: info.contentType,
      startTime: null, endTime: null,
      category: this._categorize(info.filename, info.contentType),
      headers: options.headers || {},
      createdAt: Date.now()
    };

    // 检查进度文件
    const progressFile = filePath + '.wqp';
    if (await fs.pathExists(progressFile)) {
      try {
        const saved = await fs.readJson(progressFile);
        if (saved.url === url) {
          task.downloaded = saved.downloaded || 0;
          task.chunks = saved.chunks || [];
          task.status = 'paused';
        }
      } catch (e) { /* 进度文件损坏，忽略 */ }
    }

    this.activeDownloads.set(id, task);
    return task;
  }

  // ========== 开始下载 ==========
  async start(id) {
    const task = this.activeDownloads.get(id);
    if (!task) throw new Error('任务不存在');

    if (this.running >= this.maxConcurrent) {
      task.status = 'queued';
      this.queue.push(id);
      return task;
    }

    task.status = 'downloading';
    task.startTime = task.startTime || Date.now();
    this.running++;

    try {
      // 续传校验
      if (task.downloaded > 0 && (task.etag || task.lastModified)) {
        const fileChanged = await this._validateResume(task);
        if (fileChanged) {
          console.log(`⚠️ 文件已变更(${task.filename})，从头下载`);
          task.downloaded = 0;
          task.chunks = [];
          await fs.remove(task.filePath + '.wqp').catch(() => {});
          await fs.remove(task.filePath + '.parts').catch(() => {});
          await fs.remove(task.filePath).catch(() => {});
        }
      }

      if (task.supportsMultiThread && task.totalSize > 0) {
        await this._multiThreadDownload(task);
      } else {
        await this._singleThreadDownload(task);
      }
    } catch (err) {
      task.status = 'error';
      task.error = err.message;
      this.running--;
      this._processQueue();
      this._emit('error', task, err);
    }

    return task;
  }

  // ========== 续传校验 ==========
  async _validateResume(task) {
    try {
      const response = await got.head(task.url, {
        headers: { 'User-Agent': this.userAgent, ...task.headers },
        timeout: { request: 10000 }, followRedirect: true, maxRedirects: 10
      });
      const newEtag = response.headers['etag'] || '';
      const newLastModified = response.headers['last-modified'] || '';
      const newSize = parseInt(response.headers['content-length'] || '0');

      if (task.etag && newEtag && task.etag !== newEtag) return true;
      if (task.lastModified && newLastModified && task.lastModified !== newLastModified) return true;
      if (task.totalSize > 0 && newSize > 0 && task.totalSize !== newSize) return true;
      return false;
    } catch (err) {
      return false;
    }
  }

  // ========== 单线程下载 ==========
  async _singleThreadDownload(task) {
    // 非续传时覆盖旧文件，续传时追加
    const isResume = task.downloaded > 0 && task.resumable;
    const dest = fs.createWriteStream(task.filePath, { flags: isResume ? 'a' : 'w' });
    if (!isResume) task.downloaded = 0;
    let downloaded = task.downloaded;
    const startTime = Date.now();
    let lastSpeedCheck = startTime;
    let lastDownloaded = downloaded;
    let speedSamples = [];

    const reqHeaders = { 'User-Agent': this.userAgent, ...task.headers };
    if (downloaded > 0 && task.resumable) {
      reqHeaders['Range'] = `bytes=${downloaded}-`;
    }

    const downloadStream = got.stream(task.url, {
      headers: reqHeaders,
      timeout: { request: 60000 }, followRedirect: true, maxRedirects: 10,
      ...(this.proxy ? { proxy: this.proxy } : {})
    });

    // 令牌桶限速
    downloadStream.on('data', (chunk) => {
      const waitMs = this._bucket.consume(chunk.length);
      if (waitMs > 0) {
        downloadStream.pause();
        setTimeout(() => downloadStream.resume(), Math.min(waitMs, 1000));
      }

      downloaded += chunk.length;
      task.downloaded = downloaded;

      const now = Date.now();
      if (now - lastSpeedCheck >= 500) {
        const speed = (downloaded - lastDownloaded) / ((now - lastSpeedCheck) / 1000);
        speedSamples.push(speed);
        if (speedSamples.length > 10) speedSamples.shift();
        task.speed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        lastSpeedCheck = now;
        lastDownloaded = downloaded;
        if (task.totalSize > 0) {
          task.progress = Math.min(100, (downloaded / task.totalSize * 100));
        }
        this._emit('progress', task);
        this._saveProgress(task);
      }
    });

    downloadStream.on('end', () => {
      task.downloaded = downloaded;
      task.status = 'completed';
      task.endTime = Date.now();
      task.progress = 100;
      this.running--;
      fs.remove(task.filePath + '.wqp').catch(() => {});
      this._emit('completed', task);
      this._processQueue();
    });

    downloadStream.on('error', (err) => {
      task.status = 'error';
      task.error = err.message;
      this.running--;
      this._saveProgress(task);
      this._emit('error', task, err);
      this._processQueue();
    });

    downloadStream.pipe(dest);
    task._stream = downloadStream;
  }

  // ========================================================
  // 核心：多线程分片下载 v3.0 — IDM式分片队列调度
  // ========================================================
  // IDM的秘诀不是"动态重分配"，而是"分片队列"：
  // - 文件切成很多小分片（不是N个等大分片，而是M个小分片，M >> N）
  // - N个工作线程从队列取分片下载
  // - 快线程完成一个分片后立即取下一个，自然下载更多
  // - 不存在"偷分片"的竞态问题，完全避免了数据重叠
  // ========================================================
  async _multiThreadDownload(task) {
    // 1. 计算分片策略
    const chunkSize = this._calculateChunkSize(task.totalSize);
    const chunks = [];
    let chunkIndex = 0;
    for (let start = 0; start < task.totalSize; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, task.totalSize - 1);
      chunks.push({
        index: chunkIndex++,
        start, end,
        downloaded: 0,
        status: 'waiting',
        retries: 0
      });
    }

    task.chunks = chunks;
    const tempDir = task.filePath + '.parts';
    await fs.ensureDir(tempDir);

    // 2. 下载队列（待下载的分片索引）
    const pendingQueue = chunks.map((_, i) => i);

    // 3. 统计
    let lastSpeedCheck = Date.now();
    let lastDownloaded = 0;
    let speedSamples = [];
    let taskCompleted = false;
    let mergePromise = null;

    // 4. 信号量控制并发
    const semaphore = {
      _waiting: [],
      _count: this.concurrency,
      acquire() {
        if (this._count > 0) { this._count--; return Promise.resolve(); }
        return new Promise(r => this._waiting.push(r));
      },
      release() {
        this._count++;
        if (this._waiting.length > 0) { this._count--; this._waiting.shift()(); }
      }
    };

    // 5. 下载单个分片
    const downloadOneChunk = async (chunk) => {
      await semaphore.acquire();

      const partFile = path.join(tempDir, `part_${chunk.index}`);
      const MAX_RETRIES = 3;
      const STALL_TIMEOUT = 30000;

      try {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          chunk.status = 'downloading';

          // 检查已下载部分（仅续传时复用，重试时从头下载）
          const isRetry = attempt > 0;
          if (await fs.pathExists(partFile)) {
            if (isRetry) {
              // 重试：删掉旧部分文件，从头下载这个分片
              await fs.remove(partFile);
              chunk.downloaded = 0;
            } else {
              // 首次尝试：可能是续传
              const stat = await fs.stat(partFile);
              chunk.downloaded = stat.size;
            }
          }

          const rangeStart = chunk.start + chunk.downloaded;
          if (rangeStart > chunk.end) {
            chunk.status = 'completed';
            break;
          }

          // flags: 首次续传用追加，重试或新分片用覆盖
          const writeFlags = (!isRetry && chunk.downloaded > 0) ? 'a' : 'w';

          try {
            await new Promise((resolve, reject) => {
              const dest = fs.createWriteStream(partFile, { flags: writeFlags });
              let lastDataTime = Date.now();
              let stallTimer = null;
              let resolved = false;

              const cleanup = () => {
                if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
              };

              const stream = got.stream(task.url, {
                headers: {
                  'User-Agent': this.userAgent,
                  'Range': `bytes=${rangeStart}-${chunk.end}`,
                  ...task.headers
                },
                timeout: { request: 30000 },
                followRedirect: true, maxRedirects: 10,
                ...(this.proxy ? { proxy: this.proxy } : {})
              });

              // 卡死检测
              stallTimer = setInterval(() => {
                if (Date.now() - lastDataTime > STALL_TIMEOUT) {
                  cleanup();
                  stream.destroy(new Error(`分片${chunk.index}超时(30s无数据)`));
                }
              }, 5000);

              stream.on('data', (data) => {
                lastDataTime = Date.now();

                // 令牌桶限速
                const waitMs = this._bucket.consume(data.length);
                if (waitMs > 0) {
                  stream.pause();
                  setTimeout(() => stream.resume(), Math.min(waitMs, 1000));
                }

                chunk.downloaded += data.length;
                task.downloaded = task.chunks.reduce((sum, c) => sum + c.downloaded, 0);

                // 全局速度计算
                const now = Date.now();
                if (now - lastSpeedCheck >= 500) {
                  const speed = (task.downloaded - lastDownloaded) / ((now - lastSpeedCheck) / 1000);
                  speedSamples.push(speed);
                  if (speedSamples.length > 10) speedSamples.shift();
                  task.speed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
                  lastSpeedCheck = now;
                  lastDownloaded = task.downloaded;
                  task.progress = Math.min(100, (task.downloaded / task.totalSize * 100));
                  this._emit('progress', task);
                  this._saveProgress(task);
                }
              });

              stream.on('end', () => {
                cleanup();
                dest.end();
                chunk.status = 'completed';
                if (!resolved) { resolved = true; resolve(); }
              });

              stream.on('error', (err) => {
                cleanup();
                dest.destroy();
                if (!resolved) { resolved = true; reject(err); }
              });

              dest.on('error', (err) => {
                cleanup();
                stream.destroy();
                if (!resolved) { resolved = true; reject(err); }
              });

              stream.pipe(dest);
            });

            // 分片下载成功，跳出重试循环
            break;

          } catch (err) {
            chunk.retries = attempt + 1;
            // 记录失败，自动降线程
            this._recordChunkFailure(task.id, chunk.index);

            if (attempt < MAX_RETRIES) {
              console.log(`⚠️ 分片${chunk.index}第${attempt + 1}次失败，重试... (${err.message})`);
              await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
            } else {
              chunk.status = 'error';
              chunk.error = err.message;
              console.error(`❌ 分片${chunk.index}重试${MAX_RETRIES}次后仍失败: ${err.message}`);
            }
          }
        }
      } finally {
        semaphore.release();
      }
    };

    // 6. 工作线程：循环从队列取分片下载
    const worker = async () => {
      while (pendingQueue.length > 0 && !taskCompleted) {
        if (task.status !== 'downloading') break;
        const idx = pendingQueue.shift();
        if (idx === undefined) break;
        const chunk = chunks[idx];
        await downloadOneChunk(chunk);
      }
    };

    // 7. 启动工作线程
    task.status = 'downloading';
    this._emit('started', task);

    const numWorkers = Math.min(this.maxConnections, chunks.length);
    const workers = [];
    for (let i = 0; i < numWorkers; i++) {
      workers.push(worker());
    }

    await Promise.allSettled(workers);

    // 8. 检查结果
    const allFailed = chunks.every(c => c.status === 'error');
    if (allFailed && !taskCompleted) {
      console.log('⚠️ 多线程全部失败，降级到单线程');
      task.chunks = [];
      task.status = 'downloading';
      await fs.remove(tempDir).catch(() => {});
      await this._singleThreadDownload(task);
      return;
    }

    // 9. 合并分片
    if (!taskCompleted) {
      taskCompleted = true;
      await this._mergeChunks(task, tempDir);
      task.status = 'completed';
      task.endTime = Date.now();
      task.progress = 100;
      task.speed = 0;
      this.running--;
      await fs.remove(tempDir).catch(() => {});
      await fs.remove(task.filePath + '.wqp').catch(() => {});
      this._emit('completed', task);
      this._processQueue();
    }
  }

  /**
   * 计算分片大小 — IDM策略
   * 分片太多：HTTP请求开销大
   * 分片太少：负载不均衡
   * 折中：maxConnections * 4个分片，每片256KB~8MB
   */
  _calculateChunkSize(totalSize) {
    const targetChunks = this.maxConnections * 4;
    let chunkSize = Math.ceil(totalSize / targetChunks);
    chunkSize = Math.max(256 * 1024, Math.min(8 * 1024 * 1024, chunkSize));
    // 4KB对齐
    chunkSize = Math.ceil(chunkSize / 4096) * 4096;
    return chunkSize;
  }

  // ========== 合并分片 — 简化版 ==========
  async _mergeChunks(task, tempDir) {
    // 按index排序（index就是按start位置递增的）
    const completedChunks = task.chunks
      .filter(c => c.status === 'completed')
      .sort((a, b) => a.start - b.start);

    const dest = fs.createWriteStream(task.filePath);

    for (const chunk of completedChunks) {
      const partFile = path.join(tempDir, `part_${chunk.index}`);
      if (await fs.pathExists(partFile)) {
        const data = await fs.readFile(partFile);
        // 精确截取：只写入该分片应有的字节数
        const expectedSize = chunk.end - chunk.start + 1;
        const writeData = data.length > expectedSize ? data.slice(0, expectedSize) : data;
        dest.write(writeData);
      }
    }

    return new Promise(resolve => {
      dest.end(() => {
        // 合并后强制截断到正确总大小（防止分片边界累积误差）
        fs.truncate(task.filePath, task.totalSize, (err) => {
          if (err) console.warn('截断失败:', err.message);
          resolve();
        });
      });
    });
  }

  // ========== 暂停下载 ==========
  pause(id) {
    const task = this.activeDownloads.get(id);
    if (!task || task.status !== 'downloading') return task;

    task.status = 'paused';
    task.speed = 0;

    if (task.connections) {
      task.connections.forEach(conn => {
        if (conn.stream && conn.stream.destroy) conn.stream.destroy();
      });
      task.connections = [];
    }
    if (task._stream && task._stream.destroy) task._stream.destroy();

    this.running--;
    this._saveProgress(task);
    this._processQueue();
    this._emit('paused', task);
    return task;
  }

  // ========== 恢复下载 ==========
  resume(id) { return this.start(id); }

  // ========== 取消下载 ==========
  async cancel(id) {
    const task = this.activeDownloads.get(id);
    if (!task) return;
    if (task.status === 'downloading') this.pause(id);
    await fs.remove(task.filePath + '.parts').catch(() => {});
    await fs.remove(task.filePath + '.wqp').catch(() => {});
    await fs.remove(task.filePath).catch(() => {});
    this.activeDownloads.delete(id);
    this._emit('cancelled', task);
  }

  // ========== 删除记录 ==========
  remove(id, deleteFile = false) {
    const task = this.activeDownloads.get(id);
    if (!task) return;
    if (deleteFile) fs.remove(task.filePath).catch(() => {});
    fs.remove(task.filePath + '.wqp').catch(() => {});
    this.activeDownloads.delete(id);
  }

  // ========== 保存进度 ==========
  async _saveProgress(task) {
    const progressFile = task.filePath + '.wqp';
    try {
      await fs.writeJson(progressFile, {
        id: task.id, url: task.url, filename: task.filename,
        totalSize: task.totalSize, downloaded: task.downloaded,
        chunks: task.chunks.map(c => ({
          index: c.index, start: c.start, end: c.end, downloaded: c.downloaded, status: c.status
        })),
        etag: task.etag, lastModified: task.lastModified, headers: task.headers
      });
    } catch (e) { /* 保存失败不中断 */ }
  }

  // ========== 队列调度 ==========
  _processQueue() {
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      this.start(this.queue.shift());
    }
  }

  // ========== 文件分类 ==========
  _categorize(filename, contentType) {
    const ext = path.extname(filename).toLowerCase();
    const cats = {
      '视频': ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.ts','.m3u8'],
      '音频': ['.mp3','.flac','.wav','.aac','.ogg','.wma','.m4a','.ape'],
      '压缩包': ['.zip','.rar','.7z','.tar','.gz','.bz2','.xz'],
      '程序': ['.exe','.msi','.dmg','.deb','.rpm','.apk'],
      '文档': ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.md'],
      '图片': ['.jpg','.jpeg','.png','.gif','.bmp','.svg','.webp','.ico'],
      '种子': ['.torrent'],
    };
    for (const [cat, exts] of Object.entries(cats)) {
      if (exts.includes(ext)) return cat;
    }
    if (contentType) {
      if (contentType.startsWith('video/')) return '视频';
      if (contentType.startsWith('audio/')) return '音频';
      if (contentType.includes('zip') || contentType.includes('compressed')) return '压缩包';
      if (contentType.includes('pdf') || contentType.includes('document')) return '文档';
      if (contentType.startsWith('image/')) return '图片';
    }
    return '其他';
  }

  // ========== 事件系统 ==========
  on(event, callback) {
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  _emit(event, ...args) {
    if (!this._listeners || !this._listeners[event]) return;
    this._listeners[event].forEach(cb => { try { cb(...args); } catch (e) { console.error('Event error:', e); } });
  }

  getAll() { return Array.from(this.activeDownloads.values()); }
  get(id) { return this.activeDownloads.get(id); }

  setSpeedLimit(bytesPerSecond) {
    this.speedLimit = bytesPerSecond;
    this._bucket.setRate(bytesPerSecond);
  }

  setMaxConnections(count) {
    this.maxConnections = Math.min(32, Math.max(1, count));
  }

  // ========== 自动降线程 ==========
  _recordChunkFailure(taskId, chunkIndex) {
    if (!this._failureWindow[taskId]) {
      this._failureWindow[taskId] = { failures: [], lastReduce: Date.now() };
    }
    const win = this._failureWindow[taskId];
    win.failures.push({ chunkIndex, time: Date.now() });
    const cutoff = Date.now() - 60000;
    win.failures = win.failures.filter(f => f.time > cutoff);
    if (win.failures.length >= 5 && Date.now() - win.lastReduce > 10000) {
      const old = this.concurrency;
      this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
      win.lastReduce = Date.now();
      console.log(`⚠️ 自动降线程: 并发 ${old} → ${this.concurrency}`);
    }
  }

  // ========================================================
  // m3u8/HLS 流媒体下载 v3.0 — 支持加密解密
  // ========================================================
  async downloadM3U8(m3u8Url, savePath, options = {}) {
    const id = uuidv4();
    const task = {
      id, url: m3u8Url, filename: '', filePath: '',
      totalSize: 0, downloaded: 0, speed: 0, progress: 0,
      status: 'analyzing', resumable: false, supportsMultiThread: false,
      connections: [], chunks: [], etag: '', lastModified: '',
      contentType: 'application/vnd.apple.mpegurl',
      startTime: null, endTime: null, category: '视频',
      headers: options.headers || {}, createdAt: Date.now(),
      isM3U8: true, segments: [], currentSegment: 0
    };

    this.activeDownloads.set(id, task);

    try {
      // 1. 下载m3u8播放列表
      const playlist = await this._fetchM3U8(m3u8Url, options.headers);

      if (playlist.isMaster) {
        const bestVariant = playlist.variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
        if (bestVariant) {
          const variantUrl = new URL(bestVariant.uri, m3u8Url).href;
          const sub = await this._fetchM3U8(variantUrl, options.headers);
          task.segments = sub.segments;
          task.url = variantUrl;
        }
      } else {
        task.segments = playlist.segments;
      }

      if (task.segments.length === 0) {
        throw new Error('m3u8播放列表中没有找到视频片段');
      }

      // 2. 设置文件名
      const baseName = options.filename || path.basename(new URL(m3u8Url).pathname, '.m3u8') || 'video';
      task.filename = baseName + '.ts';
      task.filePath = path.join(savePath, task.filename);
      task.totalSize = task.segments.length;
      task.status = 'downloading';
      task.startTime = Date.now();
      this.running++;
      this._emit('started', task);

      // 3. 逐段下载TS片段
      const tempDir = task.filePath + '.ts_parts';
      await fs.ensureDir(tempDir);

      const batchSize = this.concurrency;
      let lastSpeedCheck = Date.now();
      let lastDownloaded = 0;
      let speedSamples = [];

      for (let i = 0; i < task.segments.length; i += batchSize) {
        if (task.status === 'paused' || task.status === 'error') break;

        const batch = task.segments.slice(i, Math.min(i + batchSize, task.segments.length));
        const batchPromises = batch.map((seg, idx) => {
          const segIndex = i + idx;
          const segUrl = new URL(seg.uri, m3u8Url).href;
          const segFile = path.join(tempDir, `seg_${String(segIndex).padStart(5, '0')}.ts`);
          // 传递加密信息
          return this._downloadSegment(segUrl, segFile, options.headers, seg.encryption);
        });

        await Promise.allSettled(batchPromises);
        task.currentSegment = Math.min(i + batchSize, task.segments.length);
        task.downloaded = task.currentSegment;
        task.progress = Math.min(100, (task.currentSegment / task.segments.length) * 100);

        const now = Date.now();
        if (now - lastSpeedCheck >= 500) {
          const speed = (task.downloaded - lastDownloaded) / ((now - lastSpeedCheck) / 1000);
          speedSamples.push(speed);
          if (speedSamples.length > 10) speedSamples.shift();
          task.speed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
          lastSpeedCheck = now;
          lastDownloaded = task.downloaded;
          this._emit('progress', task);
        }
      }

      if (task.status === 'paused') {
        this.running--;
        this._saveProgress(task);
        this._emit('paused', task);
        return task;
      }

      // 4. 合并TS片段
      task.status = 'merging';
      this._emit('progress', task);
      await this._mergeTSSegments(task, tempDir);

      // 5. 清理
      await fs.remove(tempDir).catch(() => {});
      task.status = 'completed';
      task.endTime = Date.now();
      task.progress = 100;
      task.speed = 0;
      this.running--;
      this._emit('completed', task);
      this._processQueue();

    } catch (err) {
      task.status = 'error';
      task.error = err.message;
      this.running--;
      this._emit('error', task, err);
      this._processQueue();
    }

    return task;
  }

  // ========== 获取m3u8 ==========
  async _fetchM3U8(url, headers = {}) {
    const response = await got(url, {
      headers: { 'User-Agent': this.userAgent, ...headers },
      timeout: { request: this.timeout }, followRedirect: true, maxRedirects: 10
    });
    return this._parseM3U8(response.body, url);
  }

  // ========== 解析m3u8 — 增加加密支持 ==========
  _parseM3U8(content, baseUrl) {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    const result = { isMaster: false, variants: [], segments: [] };

    let currentBandwidth = 0;
    let currentEncryption = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === '#EXTM3U') continue;

      // Master playlist
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        result.isMaster = true;
        const bwMatch = line.match(/BANDWIDTH=(\d+)/);
        currentBandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          result.variants.push({ uri: lines[i + 1], bandwidth: currentBandwidth });
        }
      }

      // 加密标签 #EXT-X-KEY
      if (line.startsWith('#EXT-X-KEY:')) {
        currentEncryption = this._parseEncryption(line, baseUrl);
      }

      // 片段
      if (line.startsWith('#EXTINF:')) {
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          result.segments.push({
            uri: lines[i + 1],
            duration: parseFloat(line.split(':')[1]) || 0,
            encryption: currentEncryption ? { ...currentEncryption } : null
          });
        }
      }
    }

    return result;
  }

  // ========== 解析加密标签 ==========
  _parseEncryption(line, baseUrl) {
    const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/);
    const uriMatch = line.match(/URI="([^"]+)"/);
    const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);

    const method = methodMatch ? methodMatch[1] : 'NONE';
    if (method === 'NONE') return null;

    return {
      method,  // AES-128, AES-256, etc.
      keyUrl: uriMatch ? new URL(uriMatch[1], baseUrl).href : null,
      iv: ivMatch ? Buffer.from(ivMatch[1], 'hex') : null
    };
  }

  // ========== 下载单个TS片段 — 支持解密 ==========
  async _downloadSegment(url, destPath, headers = {}, encryption = null) {
    if (await fs.pathExists(destPath)) return; // 已下载

    const encryptedData = await new Promise((resolve, reject) => {
      const chunks = [];
      const stream = got.stream(url, {
        headers: { 'User-Agent': this.userAgent, ...headers },
        timeout: { request: 30000 }, followRedirect: true, maxRedirects: 10
      });
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });

    let finalData = encryptedData;

    // 解密
    if (encryption && encryption.method === 'AES-128' && encryption.keyUrl) {
      try {
        // 获取解密密钥
        const keyResponse = await got(encryption.keyUrl, {
          headers: { 'User-Agent': this.userAgent, ...headers },
          timeout: { request: 10000 }, followRedirect: true, maxRedirects: 10
        });
        const key = Buffer.from(keyResponse.rawBody || keyResponse.body);

        // IV：默认用分片序号
        let iv = encryption.iv;
        if (!iv) {
          iv = Buffer.alloc(16);
          // 从URL提取序号作为IV
          const segNum = parseInt(path.basename(new URL(url).pathname).replace(/[^0-9]/g, '')) || 0;
          iv.writeUInt32BE(segNum, 12);
        }

        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        finalData = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      } catch (err) {
        console.log(`⚠️ 解密失败(${url}): ${err.message}，保存原始数据`);
      }
    }

    await fs.writeFile(destPath, finalData);
  }

  // ========== 合并TS片段 ==========
  async _mergeTSSegments(task, tempDir) {
    const files = (await fs.readdir(tempDir))
      .filter(f => f.startsWith('seg_') && f.endsWith('.ts'))
      .sort();

    const dest = fs.createWriteStream(task.filePath);
    for (const file of files) {
      const data = await fs.readFile(path.join(tempDir, file));
      dest.write(data);
    }
    return new Promise(resolve => dest.end(resolve));
  }
}

module.exports = DownloadEngine;

/** 格式化文件大小 */
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
