/**
 * 问渠下载器 - 内容脚本（深度Hook层）
 * 注入到所有网页，模仿IDM的document.js
 * 劫持 fetch/XHR/视频元素，拦截下载请求
 */

(function() {
  'use strict';

  // 避免重复注入
  if (window.__wenquInjected) return;
  window.__wenquInjected = true;

  const FILE_EXTENSIONS = [
    '.exe','.msi','.dmg','.deb','.rpm','.apk','.zip','.rar','.7z','.tar','.gz',
    '.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.ts','.m3u8',
    '.mp3','.flac','.wav','.aac','.ogg','.wma','.m4a','.ape',
    '.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx',
    '.iso','.img','.bin','.torrent',
    '.jpg','.jpeg','.png','.gif','.bmp','.svg','.webp','.psd'
  ];

  const MEDIA_TYPES = [
    'video/', 'audio/', 'application/octet-stream',
    'application/zip', 'application/x-rar', 'application/x-7z',
    'application/x-tar', 'application/gzip', 'application/x-bzip2',
    'application/pdf', 'application/msword', 'application/vnd.',
    'application/x-iso9660-image', 'application/x-apple-diskimage'
  ];

  const DOWNLOAD_FILE_SIZE = 1024 * 1024; // 1MB以上才接管

  // ========== 1. 劫持 Fetch API ==========
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input?.url || '';
    
    // 检查是否是下载类型URL
    if (isDownloadUrl(url)) {
      sendToDownloader(url, {
        referer: window.location.href,
        method: init?.method || 'GET',
        headers: init?.headers || {}
      });
      return new Response(null, { status: 200, statusText: 'WenQu Downloader Intercepted' });
    }

    const response = await originalFetch.apply(this, args);
    
    // 检查响应头判断是否是下载
    const contentType = response.headers.get('content-type') || '';
    const contentDisposition = response.headers.get('content-disposition') || '';
    const contentLength = parseInt(response.headers.get('content-length') || '0');

    if (shouldInterceptResponse(url, contentType, contentDisposition, contentLength)) {
      sendToDownloader(url, {
        referer: window.location.href,
        contentType,
        contentLength
      });
      return new Response(null, { status: 200, statusText: 'WenQu Downloader Intercepted' });
    }

    return response;
  };

  // ========== 2. 劫持 XMLHttpRequest ==========
  const OriginalXHR = window.XMLHttpRequest;
  const originalXHROpen = OriginalXHR.prototype.open;
  const originalXHRSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function(method, url, ...rest) {
    this._wenquUrl = url;
    this._wenquMethod = method;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  OriginalXHR.prototype.send = function(body) {
    const xhr = this;
    const url = xhr._wenquUrl || '';
    
    if (isDownloadUrl(url)) {
      sendToDownloader(url, {
        referer: window.location.href,
        method: xhr._wenquMethod || 'GET'
      });
      // 模拟成功响应
      Object.defineProperty(xhr, 'readyState', { value: 4 });
      Object.defineProperty(xhr, 'status', { value: 200 });
      Object.defineProperty(xhr, 'responseText', { value: '' });
      if (xhr.onreadystatechange) xhr.onreadystatechange();
      if (xhr.onload) xhr.onload();
      return;
    }

    return originalXHRSend.apply(this, [body]);
  };

  // ========== 3. 监听链接点击 ==========
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;

    const url = link.href;
    if (!url || url.startsWith('javascript:') || url.startsWith('#')) return;

    if (isDownloadUrl(url)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      sendToDownloader(url, { referer: window.location.href });
    }
  }, true);

  // ========== 4. 视频嗅探 ==========
  const videoUrls = new Set();
  
  // 监听 <video> 和 <audio> 元素
  const observeMedia = () => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          
          // 检查 video/audio 元素
          const mediaElements = node.tagName === 'VIDEO' || node.tagName === 'AUDIO'
            ? [node]
            : node.querySelectorAll ? node.querySelectorAll('video, audio, source') : [];
          
          mediaElements.forEach(el => {
            const src = el.src || el.getAttribute('src');
            if (src && !videoUrls.has(src)) {
              videoUrls.add(src);
              notifyVideoFound(src, el.tagName.toLowerCase());
            }
            // 监听 src 属性变化
            const srcObserver = new MutationObserver(() => {
              const newSrc = el.src || el.getAttribute('src');
              if (newSrc && !videoUrls.has(newSrc)) {
                videoUrls.add(newSrc);
                notifyVideoFound(newSrc, el.tagName.toLowerCase());
              }
            });
            srcObserver.observe(el, { attributes: true, attributeFilter: ['src'] });
          });
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  };

  // 页面加载后开始监听
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeMedia);
  } else {
    observeMedia();
  }

  // 扫描已有的 media 元素
  setTimeout(() => {
    document.querySelectorAll('video, audio, source').forEach(el => {
      const src = el.src || el.getAttribute('src');
      if (src && !videoUrls.has(src)) {
        videoUrls.add(src);
        notifyVideoFound(src, el.tagName.toLowerCase());
      }
    });
  }, 2000);

  // ========== 5. 监听 m3u8 流媒体 ==========
  // 通过拦截 fetch 响应体来检测 m3u8
  const _originalFetch = originalFetch; // 保存我们自己的fetch（已是原始fetch）
  
  // 监听所有网络请求中的 m3u8
  const observerM3U8 = () => {
    // 扫描页面中所有 video 元素的 src
    setInterval(() => {
      document.querySelectorAll('video').forEach(v => {
        if (v.src && v.src.includes('.m3u8') && !videoUrls.has(v.src)) {
          videoUrls.add(v.src);
          notifyVideoFound(v.src, 'm3u8');
        }
        // 检查 source 子元素
        v.querySelectorAll('source').forEach(s => {
          const src = s.src || s.getAttribute('src');
          if (src && (src.includes('.m3u8') || src.includes('.mp4')) && !videoUrls.has(src)) {
            videoUrls.add(src);
            notifyVideoFound(src, src.includes('.m3u8') ? 'm3u8' : 'video');
          }
        });
      });
    }, 3000);
  };
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observerM3U8);
  } else {
    observerM3U8();
  }

  // ========== 辅助函数 ==========

  function isDownloadUrl(url) {
    try {
      const pathname = new URL(url, window.location.href).pathname.toLowerCase();
      // 检查文件扩展名
      for (const ext of FILE_EXTENSIONS) {
        if (pathname.endsWith(ext)) return true;
      }
      // 检查常见下载参数
      if (url.includes('download=') || url.includes('action=download')) return true;
    } catch (e) {}
    return false;
  }

  function shouldInterceptResponse(url, contentType, contentDisposition, contentLength) {
    // Content-Disposition: attachment
    if (contentDisposition && contentDisposition.includes('attachment')) return true;
    
    // 大文件的媒体类型
    if (contentLength > DOWNLOAD_FILE_SIZE) {
      for (const type of MEDIA_TYPES) {
        if (contentType.startsWith(type)) return true;
      }
    }
    
    return false;
  }

  function sendToDownloader(url, options = {}) {
    // 通过 background.js 转发，避免 HTTPS 页面的 Mixed Content 拦截
    try {
      chrome.runtime.sendMessage({
        type: 'download',
        url,
        referer: options.referer || window.location.href,
        headers: options.headers || {},
        filename: options.filename || ''
      }, (response) => {
        if (!response || response.error) {
          // 桌面端未运行，回退到浏览器默认下载
          console.log('[问渠下载器] 桌面端未运行，使用浏览器默认下载');
          window.open(url, '_blank');
        }
      });
    } catch (e) {
      // 扩展上下文已失效（页面卸载等）
      console.log('[问渠下载器] 发送失败，回退默认下载');
      window.open(url, '_blank');
    }
  }

  function notifyVideoFound(url, type) {
    // 统一通过 chrome.runtime.sendMessage 通知 background.js
    // background.js 负责转发到桌面端，避免 Mixed Content 拦截
    try {
      chrome.runtime.sendMessage({
        type: 'video_found',
        url,
        mediaType: type,
        pageUrl: window.location.href,
        pageTitle: document.title,
        timestamp: Date.now()
      });
    } catch (e) {}
  }

  // ========== 右键菜单"使用问渠下载器下载" ==========
  document.addEventListener('contextmenu', (e) => {
    const link = e.target.closest('a[href]');
    if (link && link.href) {
      try {
        chrome.runtime.sendMessage({
          type: 'context_link',
          url: link.href
        });
      } catch (e) {}
    }
  });

  console.log('[问渠下载器] 内容脚本已注入');
})();
