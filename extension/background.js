/**
 * 问渠下载器 - Background Service Worker
 * 处理浏览器事件、右键菜单、webRequest拦截、消息路由
 */

const DESKTOP_PORT = 15888;
const DESKTOP_URL = `http://127.0.0.1:${DESKTOP_PORT}`;

// ========== 右键菜单 ==========
chrome.runtime.onInstalled.addListener(() => {
  // 主菜单
  chrome.contextMenus.create({
    id: 'wenqu-download',
    title: '🦞 使用问渠下载器下载',
    contexts: ['link', 'image', 'video', 'audio']
  });

  chrome.contextMenus.create({
    id: 'wenqu-download-page',
    title: '🦞 下载此页面所有链接',
    contexts: ['page']
  });

  chrome.contextMenus.create({
    id: 'wenqu-download-selected',
    title: '🦞 下载选中的链接',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'wenqu-sniff-video',
    title: '🦞 嗅探页面视频',
    contexts: ['page']
  });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'wenqu-download') {
    const url = info.linkUrl || info.srcUrl || info.pageUrl;
    sendToDesktop(url, { referer: info.pageUrl });
  } else if (info.menuItemId === 'wenqu-download-page') {
    // 注入脚本获取页面所有链接
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractAllLinks
    }, (results) => {
      if (results && results[0] && results[0].result) {
        results[0].result.forEach(url => sendToDesktop(url, { referer: tab.url }));
      }
    });
  } else if (info.menuItemId === 'wenqu-sniff-video') {
    // 嗅探页面视频
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: sniffVideos
    }, (results) => {
      if (results && results[0] && results[0].result) {
        results[0].result.forEach(url => sendToDesktop(url, { referer: tab.url }));
      }
    });
  }
});

// ========== webRequest 拦截 ==========
// 监听响应头，检测下载类型
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // 只拦截主框架和sub_frame
    if (details.type !== 'main_frame' && details.type !== 'sub_frame') return;

    const headers = details.responseHeaders || [];
    let contentType = '';
    let contentDisposition = '';
    let contentLength = 0;

    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = h.value;
      if (name === 'content-disposition') contentDisposition = h.value;
      if (name === 'content-length') contentLength = parseInt(h.value) || 0;
    }

    // 检测附件下载
    if (contentDisposition && contentDisposition.includes('attachment')) {
      const filename = extractFilename(contentDisposition);
      sendToDesktop(details.url, { 
        referer: details.initiator || '',
        filename,
        contentType,
        contentLength 
      });
      return { cancel: true };
    }

    // 检测大文件媒体类型
    if (contentLength > 1024 * 1024) {
      const downloadTypes = [
        'application/octet-stream', 'application/zip', 'application/x-rar',
        'application/x-7z', 'application/x-tar', 'application/gzip',
        'application/pdf', 'application/x-iso9660-image', 'application/x-apple-diskimage'
      ];
      if (downloadTypes.some(t => contentType.includes(t))) {
        sendToDesktop(details.url, { 
          referer: details.initiator || '',
          contentType,
          contentLength 
        });
        return { cancel: true };
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'blocking']
);

// ========== 下载拦截 ==========
// 拦截浏览器原生下载
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  // 检查桌面端是否运行
  checkDesktopRunning().then(running => {
    if (running) {
      sendToDesktop(downloadItem.url, {
        referer: downloadItem.referrer || '',
        filename: downloadItem.filename
      });
      // 取消浏览器原生下载
      chrome.downloads.cancel(downloadItem.id);
    } else {
      suggest({ filename: downloadItem.filename });
    }
  });
  return true; // 异步响应
});

// ========== 消息处理 ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'video_found') {
    // 转发视频嗅探结果到popup
    chrome.runtime.sendMessage(message).catch(() => {});
    // 转发到桌面端 sniff 接口
    try {
      fetch(`${DESKTOP_URL}/sniff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: message.url,
          type: message.mediaType,
          pageUrl: message.pageUrl || sender.tab?.url || '',
          pageTitle: message.pageTitle || '',
          timestamp: message.timestamp || Date.now()
        })
      }).catch(() => {});
    } catch (e) {}
  }
  
  if (message.type === 'check_desktop') {
    checkDesktopRunning().then(running => {
      sendResponse({ running });
    });
    return true;
  }

  if (message.type === 'download') {
    // content.js 转发的下载请求（含完整参数）
    const isM3U8 = message.url && message.url.includes('.m3u8');
    const endpoint = isM3U8 ? '/download/m3u8' : '/download';
    fetch(`${DESKTOP_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: message.url,
        referer: message.referer || '',
        headers: message.headers || {},
        filename: message.filename || ''
      })
    })
    .then(r => r.json())
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ========== 辅助函数 ==========

async function sendToDesktop(url, options = {}) {
  try {
    // 检测是否为 m3u8 流媒体
    const isM3U8 = url.includes('.m3u8');
    const endpoint = isM3U8 ? '/download/m3u8' : '/download';
    
    const response = await fetch(`${DESKTOP_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        referer: options.referer || '',
        headers: options.headers || {},
        filename: options.filename || ''
      })
    });
    return await response.json();
  } catch (e) {
    console.error('[问渠下载器] 桌面端通信失败:', e);
    return { error: '桌面端未运行' };
  }
}

async function checkDesktopRunning() {
  try {
    const response = await fetch(`${DESKTOP_URL}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    const data = await response.json();
    return data.running === true;
  } catch (e) {
    return false;
  }
}

function extractFilename(contentDisposition) {
  const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^;"'\n]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

// 注入到页面的函数：提取所有链接
function extractAllLinks() {
  const links = [];
  const fileExts = ['.exe','.msi','.zip','.rar','.7z','.mp4','.mkv','.avi','.mp3','.pdf','.iso','.torrent','.dmg'];
  document.querySelectorAll('a[href]').forEach(a => {
    const href = a.href;
    if (href && fileExts.some(ext => href.toLowerCase().includes(ext))) {
      links.push(href);
    }
  });
  return links;
}

// 注入到页面的函数：嗅探视频
function sniffVideos() {
  const urls = [];
  document.querySelectorAll('video, audio, source').forEach(el => {
    const src = el.src || el.getAttribute('src');
    if (src) urls.push(src);
  });
  // 检查 media source
  document.querySelectorAll('[data-src*=".mp4"], [data-src*=".m3u8"], [data-url*=".mp4"]').forEach(el => {
    const src = el.dataset.src || el.dataset.url;
    if (src) urls.push(src);
  });
  return urls;
}
