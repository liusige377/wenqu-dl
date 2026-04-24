/**
 * 问渠下载器 - 管理界面（纯Web版）
 * 通过 HTTP API + SSE 与本地后台通信
 */

const API = 'http://127.0.0.1:15888';
let currentFilter = 'all';
let tasks = [];
let selectedPlan = null;
let eventSource = null;

// === 初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
  await refreshTasks();
  await updateLicenseBadge();
  connectSSE();
  setInterval(refreshTasks, 3000);

  document.getElementById('downloadUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startDownload();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); showAddDownload(); }
  });
});

// === SSE实时推送 ===
function connectSSE() {
  try {
    eventSource = new EventSource(`${API}/events`);
    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      const el = document.querySelector(`[data-task-id="${data.id}"]`);
      if (el) {
        const fill = el.querySelector('.progress-fill');
        const meta = el.querySelector('.download-meta');
        if (fill) {
          fill.style.width = data.progress + '%';
          fill.className = 'progress-fill' + (data.status === 'paused' ? ' paused' : data.status === 'completed' ? ' completed' : '');
        }
        if (meta) {
          meta.innerHTML = `<span>${formatSize(data.downloaded)} / ${formatSize(data.totalSize)}</span><span>${formatSpeed(data.speed)}</span><span>${data.progress.toFixed(1)}%</span>`;
        }
      }
      updateStatusBar();
    });
    eventSource.addEventListener('completed', (e) => {
      const data = JSON.parse(e.data);
      showToast(`✅ 下载完成: ${data.filename}`, 'success');
      refreshTasks();
    });
    eventSource.addEventListener('error', (e) => {
      if (e.data) {
        const data = JSON.parse(e.data);
        showToast(`❌ 下载失败: ${data.error}`, 'error');
        refreshTasks();
      }
    });
    eventSource.addEventListener('sniff_result', (e) => {
      // 视频嗅探结果
      console.log('嗅探到媒体:', e.data);
    });
    eventSource.onerror = () => {
      // 断线重连
      setTimeout(connectSSE, 3000);
    };
  } catch (e) {
    setTimeout(connectSSE, 5000);
  }
}

// === API调用 ===
async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// === 任务刷新 ===
async function refreshTasks() {
  try {
    const data = await apiGet('/tasks');
    tasks = data.tasks || [];
    renderTasks();
    updateCategoryCounts();
    updateStatusBar();
  } catch (e) {
    // 后台未运行
    document.getElementById('totalSpeed').textContent = '未连接';
  }
}

// === 渲染任务列表 ===
function renderTasks() {
  const list = document.getElementById('downloadList');
  const empty = document.getElementById('emptyState');
  let filtered = tasks;

  if (currentFilter === 'downloading') {
    filtered = tasks.filter(t => ['downloading','paused','queued'].includes(t.status));
  } else if (currentFilter === 'completed') {
    filtered = tasks.filter(t => t.status === 'completed');
  } else if (['视频','音频','压缩包','程序','文档','图片','其他'].includes(currentFilter)) {
    filtered = tasks.filter(t => t.category === currentFilter);
  }

  if (filtered.length === 0) {
    list.innerHTML = '';
    list.appendChild(empty);
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = filtered.map(task => renderTaskItem(task)).join('');
}

function renderTaskItem(task) {
  const icons = { '视频':'🎬','音频':'🎵','压缩包':'📦','程序':'💿','文档':'📄','图片':'🖼️','其他':'📎','种子':'🌱' };
  const icon = icons[task.category] || '📎';
  const statusText = { 'waiting':'等待中','downloading':'下载中','paused':'已暂停','completed':'已完成','error':'失败','queued':'排队中' };
  const progressClass = task.status === 'completed' ? 'completed' : task.status === 'error' ? 'error' : task.status === 'paused' ? 'paused' : '';

  let actions = '';
  if (task.status === 'downloading' || task.status === 'queued') {
    actions = `<button class="btn btn-secondary btn-sm" onclick="pauseTask('${task.id}')">⏸</button>`;
  } else if (task.status === 'paused') {
    actions = `<button class="btn btn-success btn-sm" onclick="resumeTask('${task.id}')">▶</button>`;
  } else if (task.status === 'error') {
    actions = `<button class="btn btn-success btn-sm" onclick="resumeTask('${task.id}')">🔄</button>`;
  }
  if (task.status === 'completed') {
    actions = `<button class="btn btn-secondary btn-sm" onclick="openFolder('${escapeAttr(task.filePath)}')">📂</button>`;
  }
  actions += `<button class="btn btn-danger btn-sm" onclick="removeTask('${task.id}', ${task.status === 'completed'})">✕</button>`;

  return `
    <div class="download-item" data-task-id="${task.id}">
      <div class="download-icon ${task.category}">${icon}</div>
      <div class="download-info">
        <div class="download-name" title="${escapeHtml(task.filename)}">${escapeHtml(task.filename)}</div>
        <div class="download-meta">
          <span>${formatSize(task.downloaded)} / ${formatSize(task.totalSize)}</span>
          <span>${formatSpeed(task.speed)}</span>
          <span>${statusText[task.status] || task.status}</span>
          ${task.connections > 0 ? `<span>${task.connections}线程</span>` : ''}
        </div>
        <div class="progress-bar"><div class="progress-fill ${progressClass}" style="width:${task.progress}%"></div></div>
      </div>
      <div class="download-actions">${actions}</div>
    </div>`;
}

// === 下载操作 ===
function showAddDownload() {
  document.getElementById('addDownloadModal').classList.add('active');
  document.getElementById('downloadUrl').focus();
  // 自动粘贴剪贴板
  navigator.clipboard.readText().then(text => {
    if (/^https?:\/\//i.test(text)) document.getElementById('downloadUrl').value = text;
  }).catch(() => {});
}

async function startDownload() {
  const downloadUrl = document.getElementById('downloadUrl').value.trim();
  if (!downloadUrl) { showToast('请输入下载地址', 'warning'); return; }

  const savePath = document.getElementById('savePath').value.trim();
  const referer = document.getElementById('referer').value.trim();

  // 检测是否为 m3u8 流媒体
  const isM3U8 = downloadUrl.includes('.m3u8');
  const endpoint = isM3U8 ? '/download/m3u8' : '/download';

  const result = await apiPost(endpoint, {
    url: downloadUrl,
    savePath: savePath || undefined,
    referer: referer || undefined,
    headers: {}
  });

  if (result.error) {
    showToast(result.error, 'error');
    if (result.needActivation) showActivation();
  } else {
    showToast(isM3U8 ? `开始M3U8下载: ${result.filename} (${result.segments}个片段)` : `开始下载: ${result.filename}`, 'success');
    closeModal('addDownloadModal');
    document.getElementById('downloadUrl').value = '';
    await refreshTasks();
  }
}

async function pauseTask(id) { await apiPost('/pause', { taskId: id }); await refreshTasks(); }
async function resumeTask(id) { await apiPost('/resume', { taskId: id }); await refreshTasks(); }
async function removeTask(id, isCompleted) { await apiPost('/remove', { taskId: id, deleteFile: false }); await refreshTasks(); }
async function pauseAll() { await apiPost('/pause-all', {}); await refreshTasks(); }
async function resumeAll() { await apiPost('/resume-all', {}); await refreshTasks(); }
function openFolder(p) { showToast('文件已保存到: ' + p, 'success'); }

// === 分类过滤 ===
function filterCategory(cat, el) {
  currentFilter = cat;
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderTasks();
}

function updateCategoryCounts() {
  const counts = { all: tasks.length };
  counts.downloading = tasks.filter(t => ['downloading','paused','queued'].includes(t.status)).length;
  counts.completed = tasks.filter(t => t.status === 'completed').length;
  Object.keys(counts).forEach(key => {
    const el = document.getElementById(`count-${key}`);
    if (el) el.textContent = counts[key];
  });
}

// === 状态栏 ===
function updateStatusBar() {
  const total = tasks.length;
  const active = tasks.filter(t => t.status === 'downloading').length;
  const totalSpeed = tasks.reduce((sum, t) => sum + (t.speed || 0), 0);
  document.getElementById('taskCount').textContent = total;
  document.getElementById('activeCount').textContent = active;
  document.getElementById('totalSpeed').textContent = formatSpeed(totalSpeed);
}

// === 授权 ===
async function updateLicenseBadge() {
  try {
    const status = await apiGet('/license/status');
    const badge = document.getElementById('licenseBadge');
    if (status.status === 'active') {
      badge.textContent = status.type === 'lifetime' ? '已激活(终身)' : `已激活(${status.daysLeft}天)`;
      badge.className = 'license-badge active';
    } else if (status.status === 'trial') {
      badge.textContent = `试用(${status.daysLeft}天)`;
      badge.className = 'license-badge trial';
    } else {
      badge.textContent = '已过期';
      badge.className = 'license-badge expired';
    }
  } catch (e) {}
}

function showActivation() { document.getElementById('activationModal').classList.add('active'); }

function selectPlan(plan, el) {
  selectedPlan = plan;
  document.querySelectorAll('.pricing-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('paymentSection').style.display = 'block';
  document.getElementById('payAmount').textContent = plan === 'yearly' ? '¥29.9' : '¥59.9';
  document.getElementById('activateBtn').disabled = false;
}

async function activateLicense() {
  const key = document.getElementById('licenseKey').value.trim();
  if (!key) { showToast('请输入激活码', 'warning'); return; }
  const result = await apiPost('/license/activate', { key });
  if (result.success) {
    showToast(result.message, 'success');
    closeModal('activationModal');
    await updateLicenseBadge();
  } else {
    showToast(result.message, 'error');
  }
}

// === 设置 ===
async function showSettings() {
  try {
    const config = await apiGet('/config');
    document.getElementById('cfgMaxConnections').value = config.maxConnections;
    document.getElementById('cfgMaxConcurrent').value = config.maxConcurrent;
    document.getElementById('cfgSpeedLimit').value = Math.round(config.speedLimit / 1024);
    document.getElementById('cfgDefaultPath').value = config.defaultPath || '';
    document.getElementById('cfgProxy').value = config.proxy || '';
  } catch (e) {}
  document.getElementById('settingsModal').classList.add('active');
}

async function saveSettings() {
  await apiPost('/config', {
    maxConnections: parseInt(document.getElementById('cfgMaxConnections').value),
    maxConcurrent: parseInt(document.getElementById('cfgMaxConcurrent').value),
    speedLimit: parseInt(document.getElementById('cfgSpeedLimit').value) * 1024,
    defaultPath: document.getElementById('cfgDefaultPath').value.trim() || undefined,
    proxy: document.getElementById('cfgProxy').value.trim() || null
  });
  showToast('设置已保存', 'success');
  closeModal('settingsModal');
}

// === 弹窗 ===
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
function closeAllModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active')); }

// === 通知 ===
function showToast(msg, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// === 工具函数 ===
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
function formatSpeed(bps) { return formatSize(bps) + '/s'; }
function escapeHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
function escapeAttr(s) { return s ? s.replace(/\\/g,'\\\\').replace(/'/g,"\\'") : ''; }

// === 浏览器扩展安装引导 ===
function showExtGuide() {
  document.getElementById('extGuideModal').classList.add('active');
}
