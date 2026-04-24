/**
 * 问渠下载器 - Popup脚本
 */

const DESKTOP_URL = 'http://127.0.0.1:15888';

document.addEventListener('DOMContentLoaded', async () => {
  await checkStatus();
  await loadTasks();
  await loadVideos();
  
  // 自动从剪贴板粘贴
  document.getElementById('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startDownload();
  });
});

async function checkStatus() {
  try {
    const res = await fetch(`${DESKTOP_URL}/status`);
    const data = await res.json();
    document.getElementById('statusDot').className = 'dot';
    document.getElementById('statusText').textContent = `运行中 · ${data.activeDownloads}个任务`;
  } catch (e) {
    document.getElementById('statusDot').className = 'dot offline';
    document.getElementById('statusText').textContent = '未运行 - 请先打开问渠下载器';
  }
}

async function startDownload() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return;

  // 检测是否为 m3u8 流媒体
  const isM3U8 = url.includes('.m3u8');
  const endpoint = isM3U8 ? '/download/m3u8' : '/download';

  try {
    const res = await fetch(`${DESKTOP_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, referer: '' })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('urlInput').value = '';
      await loadTasks();
    }
  } catch (e) {
    alert('桌面端未运行，请先打开问渠下载器！');
  }
}

async function loadTasks() {
  try {
    const res = await fetch(`${DESKTOP_URL}/tasks`);
    const data = await res.json();
    if (data.tasks && data.tasks.length > 0) {
      document.getElementById('tasksSection').style.display = 'block';
      document.getElementById('taskList').innerHTML = data.tasks.slice(0, 5).map(task => `
        <div class="task-item">
          <div class="info">
            <div class="name">${escapeHtml(task.filename)}</div>
            <div class="progress-bar"><div class="progress-fill" style="width:${task.progress}%"></div></div>
            <div class="speed">${formatSize(task.downloaded)}/${formatSize(task.size)} · ${formatSpeed(task.speed)}</div>
          </div>
        </div>
      `).join('');
    }
  } catch (e) {}
}

async function loadVideos() {
  try {
    // 从当前页面获取嗅探结果
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const urls = [];
        document.querySelectorAll('video, audio, source').forEach(el => {
          const src = el.src || el.getAttribute('src');
          if (src) urls.push({ url: src, type: el.tagName.toLowerCase() });
        });
        return urls;
      }
    });

    if (results && results[0] && results[0].result && results[0].result.length > 0) {
      document.getElementById('videosSection').style.display = 'block';
      document.getElementById('videoList').innerHTML = results[0].result.map(v => `
        <div class="video-item">
          <span class="icon">${v.type === 'video' ? '🎬' : '🎵'}</span>
          <div class="info">
            <div class="name">${v.url.split('/').pop().split('?')[0] || v.type}</div>
            <div class="url">${escapeHtml(v.url.substring(0, 50))}...</div>
          </div>
          <button class="dl-btn" onclick="downloadVideo('${escapeAttr(v.url)}')">下载</button>
        </div>
      `).join('');
    }
  } catch (e) {}
}

async function downloadVideo(url) {
  try {
    await fetch(`${DESKTOP_URL}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, referer: '' })
    });
    await loadTasks();
  } catch (e) {}
}

function formatSize(bytes) {
  if (!bytes) return '0B';
  const u = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + u[i];
}

function formatSpeed(bps) {
  return formatSize(bps) + '/s';
}

function escapeHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
function escapeAttr(s) { return s ? s.replace(/'/g, "\\'").replace(/\\/g, '\\\\') : ''; }
