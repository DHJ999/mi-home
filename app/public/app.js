import { VideoRTC } from './video-rtc.js';

customElements.define('video-rtc', VideoRTC);

const $ = (id) => document.getElementById(id);
const H = 3600;
const M = 60;
const DAY = 86400;
const MAX_WINDOW = 255;
// 存储卡的片段之间常有 3–5 秒抖动，按 30 秒容差并成连续录像段
const GAP_TOLERANCE = 30;

const pad = (n) => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor"/></svg>';
const ICON_FS = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/></svg>';
const ICON_VOLUME = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.8v12.4L7.2 14.5H4z"/><path d="M15.5 9.2a4.2 4.2 0 0 1 0 5.6"/><path d="M18.2 6.6a7.8 7.8 0 0 1 0 10.8"/></svg>';
const ICON_MUTE = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.8v12.4L7.2 14.5H4z"/><path d="M16.2 9.8l4.6 4.6"/><path d="M20.8 9.8l-4.6 4.6"/></svg>';

const loginView = $('loginView');
const homeView = $('homeView');
const playerView = $('playerView');
const liveView = $('liveView');
const replayView = $('replayView');
const cameraGrid = $('cameraGrid');
const emptyBox = $('emptyBox');
const videoGrid = $('videoGrid');
const streamState = $('streamState');
const motorButtons = [...document.querySelectorAll('[data-direction]')];
const stage = $('stage');
const stageCard = $('stageCard');
const track = $('track');

let cameras = [];
let current = null;
let players = [];
let motorPending = 0;
let motorHold = null;
let quality = 'auto';
let qualityBusy = false;
let viewGeneration = 0;
let mode = 'live';
let liveSuspended = false;

const replay = {
  dateIndex: 0,
  time: 0,
  anchor: 0,
  zoom: '1h',
  playing: false,
  loading: false,
  dragging: false,
  dragWasPlaying: false,
  dragOrigin: 0,
  ended: false,
  endedNext: null,
  error: null,
  errorAction: 'play',
  muted: true,
  player: null,
  requestController: null,
  opToken: 0,
  switching: false,
  playFrom: 0,
  wallStart: 0,
  windowEnd: 0,
  loadTimer: null,
  statusSecond: -1,
};

let replayDates = [];
let replayListAt = 0;
const replayMemory = new Map();

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function mmss(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / M))}:${pad(sec % M)}`;
}

function dur(sec) {
  const h = Math.floor(sec / H);
  const m = Math.round((sec % H) / M);
  return h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

function dateKeyOf(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayStartOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

function weekdayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return '周' + '日一二三四五六'[new Date(y, m - 1, d).getDay()];
}

function replaySupported() {
  return ['isa.camera.hlmax', 'isa.camera.hlc7'].includes(current?.model);
}

function mainIsLive() {
  return players.some((entry) => String(entry.channel) === '0' && entry.state === 'playing');
}

function withContentType(body) {
  return { 'content-type': 'application/json', body: JSON.stringify(body) };
}

// ---------- 登录 / 设备列表 ----------

function show(view) {
  loginView.hidden = view !== 'login';
  homeView.hidden = view !== 'home';
  playerView.hidden = view !== 'player';
}

function modal(title, text) {
  $('modalTitle').textContent = title;
  $('modalText').textContent = text;
  $('modal').hidden = false;
}

$('modalOk').onclick = () => { $('modal').hidden = true; };
$('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').hidden = true; };

function setLoginMsg(text, type) {
  const el = $('loginMsg');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'msg ' + (type || 'err');
  el.textContent = text;
}

let browserPoll = null;

function setBrowserMsg(text, type) {
  const el = $('browserLoginMsg');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'msg ' + (type || 'ok');
  el.textContent = text;
}

function stopBrowserPoll() {
  if (browserPoll) { clearInterval(browserPoll); browserPoll = null; }
}

async function pollBrowserLogin() {
  stopBrowserPoll();
  browserPoll = setInterval(async () => {
    try {
      const s = await api('/api/browser-login/status');
      if (s.message) setBrowserMsg(s.message, s.state === 'error' ? 'err' : 'ok');
      if (s.state === 'ok') {
        stopBrowserPoll();
        $('browserLoginBtn').disabled = false;
        await loadState();
      } else if (s.state === 'error') {
        stopBrowserPoll();
        $('browserLoginBtn').disabled = false;
        setBrowserMsg('登录失败：' + s.message, 'err');
      }
    } catch {}
  }, 2000);
}

$('browserLoginBtn').onclick = async () => {
  $('browserLoginBtn').disabled = true;
  setBrowserMsg('正在打开小米登录窗口…', 'ok');
  try {
    await api('/api/browser-login', { method: 'POST' });
    pollBrowserLogin();
  } catch (e) {
    $('browserLoginBtn').disabled = false;
    setBrowserMsg('打开失败：' + e.message, 'err');
  }
};

$('showPassForm').onclick = () => {
  const f = $('loginForm');
  f.hidden = !f.hidden;
  $('showPassForm').textContent = f.hidden
    ? '用账号密码直接登录（不推荐，可能反复触发验证）'
    : '收起账号密码登录';
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
  return data;
}

function renderUser(user) {
  $('userLine').hidden = !user;
  $('userLine').textContent = user ? `账号 ${user}` : '';
  $('logoutBtn').hidden = !user;
}

function renderCameras() {
  cameraGrid.innerHTML = '';
  $('camCount').textContent = cameras.length ? `共 ${cameras.length} 台` : '';
  emptyBox.hidden = cameras.length > 0;
  for (const cam of cameras) {
    const card = document.createElement('div');
    card.className = 'card cam';
    card.innerHTML = `
      <div class="cam-top">
        <div class="cam-icon">📷</div>
        <div>
          <h3></h3>
          <div class="model"></div>
        </div>
      </div>
      <div class="cam-bottom">
        <span class="pill ${cam.online ? 'on' : 'off'}">${cam.online ? '在线' : '离线'}</span>
        <button class="primary" type="button">观看</button>
      </div>`;
    card.querySelector('h3').textContent = cam.name || '未命名摄像头';
    card.querySelector('.model').textContent = cam.model || '';
    card.querySelector('button').onclick = () => openPlayer(cam);
    cameraGrid.appendChild(card);
  }
}

async function loadState() {
  try {
    const s = await api('/api/state');
    if (!s.loggedIn) {
      show('login');
      renderUser('');
      const b = await api('/api/browser-login/status').catch(() => ({}));
      if (b.state === 'launching' || b.state === 'waiting') {
        $('browserLoginBtn').disabled = true;
        setBrowserMsg(b.message || '请在弹出的窗口里完成登录…', 'ok');
        pollBrowserLogin();
      }
      return;
    }
    cameras = s.cameras || [];
    renderUser(s.user);
    renderCameras();
    show('home');
  } catch (e) {
    show('login');
    setLoginMsg('本机服务没有响应，请确认启动窗口还开着。\n' + e.message, 'err');
  }
}

let verifyPoll = null;

function stopVerifyPoll() {
  if (verifyPoll) { clearInterval(verifyPoll); verifyPoll = null; }
  $('verifyStatus').hidden = true;
}

function startVerifyPoll() {
  stopVerifyPoll();
  $('verifyStatus').hidden = false;
  $('verifyStatus').textContent = '已开启自动检测，保持这个页面开着即可…';
  verifyPoll = setInterval(async () => {
    try {
      const s = await api('/api/login/status');
      if (s.state === 'pending') {
        if (s.message) $('verifyStatus').textContent = s.message;
        return;
      }
      if (s.state === 'ok') {
        stopVerifyPoll();
        $('verifyBox').hidden = true;
        $('pass').value = '';
        setLoginMsg('');
        await loadState();
        return;
      }
      if (s.state === 'error' || s.state === 'timeout') {
        stopVerifyPoll();
        setLoginMsg(s.message || '验证未完成，请重试。', 'err');
      }
    } catch {}
  }, 3000);
}

$('togglePass').onclick = () => {
  const p = $('pass');
  const on = p.type === 'password';
  p.type = on ? 'text' : 'password';
  $('togglePass').textContent = on ? '隐藏' : '显示';
};

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const user = $('user').value.trim();
  const pass = $('pass').value;
  if (!user || !pass) return;
  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = '登录中…';
  stopVerifyPoll();
  setLoginMsg('正在连接小米服务器，首次可能较慢…', 'ok');
  $('verifyBox').hidden = true;
  try {
    const r = await api('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
    if (r.status === 'ok') {
      $('pass').value = '';
      setLoginMsg('');
      cameras = r.cameras || [];
      renderUser(user);
      renderCameras();
      show('home');
    } else if (r.status === 'verify' && r.url) {
      setLoginMsg('小米要求先做一次异地登录安全验证。', 'ok');
      $('verifyBox').hidden = false;
      $('verifyLink').href = r.url;
      startVerifyPoll();
    } else {
      const detail = (r.message || '').replace(/[✅❌🔥👉🐛]/g, '').trim();
      setLoginMsg('登录失败：' + (detail || '账号或密码不对，或者触发了安全验证。'), 'err');
    }
  } catch (err) {
    setLoginMsg('登录失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
};

$('logoutBtn').onclick = async () => {
  stopVerifyPoll();
  closePlayer();
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  cameras = [];
  renderUser('');
  renderCameras();
  show('login');
  setLoginMsg('已退出，本机保存的登录态已删除。', 'ok');
};

$('refreshBtn').onclick = async () => {
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    const r = await api('/api/refresh', { method: 'POST' });
    cameras = r.cameras || [];
    renderCameras();
  } catch (e) {
    modal('刷新失败', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新设备';
  }
};

// ---------- 实时画面 ----------

function updatePlayerState() {
  if (mode === 'replay') { updateReplayChrome(); return; }
  const playing = players.filter((entry) => entry.state === 'playing').length;
  const failed = players.filter((entry) => entry.state === 'error').length;
  streamState.textContent = playing ? `${playing}/${players.length} 路直播中`
    : players.some((entry) => entry.state === 'connecting') ? '连接中…'
      : failed === players.length && players.length ? '连接失败' : '播放已停止';
  streamState.className = 'pill' + (playing ? ' on' : failed === players.length && players.length ? ' off' : '');
  $('reloadBtn').disabled = players.some((entry) => entry.state === 'connecting');
  for (const button of motorButtons) {
    // 按住转动期间不能把按钮禁掉，否则 pointerup 收不到，指针捕获也会丢
    button.disabled = !current?.ptz || !mainIsLive();
  }
  renderQualityChrome();
}

function setLensState(entry, state, text) {
  entry.state = state;
  entry.status.textContent = state === 'playing' ? '直播中'
    : state === 'error' ? '失败' : '连接中…';
  entry.status.className = 'pill' + (state === 'playing' ? ' on' : state === 'error' ? ' off' : '');
  entry.overlay.hidden = state === 'playing';
  entry.overlay.querySelector('.spinner').hidden = state !== 'connecting';
  entry.overlay.querySelector('p').textContent = text || '';
  entry.retry.disabled = state === 'connecting';
  updatePlayerState();
}

function stopLens(entry) {
  entry.controller?.abort();
  entry.controller = null;
  clearTimeout(entry.requestTimer);
  clearTimeout(entry.playTimer);
  entry.requestTimer = entry.playTimer = null;
  if (entry.player) {
    clearTimeout(entry.player.disconnectTID);
    clearTimeout(entry.player.reconnectTID);
    entry.player.disconnectTID = entry.player.reconnectTID = 0;
    entry.player.ondisconnect();
    entry.player.remove();
    entry.player = null;
  }
}

function destroyPlayer() {
  for (const entry of players) stopLens(entry);
  players = [];
  videoGrid.replaceChildren();
}

function openPlayer(cam) {
  closePlayer();
  current = cam;
  mode = 'live';
  liveSuspended = false;
  $('playerTitle').textContent = cam.name || '摄像头';
  $('motorPanel').hidden = !cam.ptz;
  motorError = '';
  setMotorStatus('连接镜头 1 后可发送转动指令。');
  quality = loadQuality();
  videoGrid.classList.toggle('dual', cam.lenses.length === 2);
  $('modeReplayBtn').disabled = !replaySupported();
  $('modeReplayBtn').title = replaySupported() ? '' : '这台机型的存储卡回放尚未接通';
  $('lensChip').textContent = cam.model === 'isa.camera.hlmax' ? '镜头 1 · 镜头 2 暂不可回放' : '镜头 1';
  $('replayHint').textContent = '橙色为有录像时段。拖动只预览时间，松手才重新建立播放流（实际约 2–4 秒）；播放到窗口末尾会自动接续下一段。'
    + (cam.model === 'isa.camera.hlmax' ? ' 镜头 2 的存储卡回放尚未接通，回放只使用镜头 1。' : '');
  players = cam.lenses.map((lens) => {
    const panel = document.createElement('section');
    panel.className = 'lens-panel';
    panel.innerHTML = `<div class="lens-head"><h3></h3><span class="pill" role="status"></span><button class="ghost lens-retry" type="button">重试此镜头</button></div>
      <div class="video-shell"><div class="video-overlay"><div class="spinner"></div><p></p></div></div>`;
    panel.querySelector('h3').textContent = lens.label;
    const entry = {
      label: lens.label, channel: lens.channel, state: 'connecting', player: null, controller: null,
      playTimer: null, requestTimer: null,
      shell: panel.querySelector('.video-shell'), overlay: panel.querySelector('.video-overlay'),
      status: panel.querySelector('.pill'), retry: panel.querySelector('.lens-retry'),
    };
    entry.retry.onclick = () => connectLens(entry);
    videoGrid.appendChild(panel);
    return entry;
  });
  setModeChrome();
  show('player');
  players.forEach(connectLens);
}

async function connectLens(entry) {
  if (!current || !players.includes(entry)) return;
  stopLens(entry);
  const camera = current;
  const generation = viewGeneration;
  const controller = new AbortController();
  entry.controller = controller;
  const active = () => generation === viewGeneration && current === camera && entry.controller === controller;
  entry.requestTimer = setTimeout(() => controller.abort(), 150000);
  setLensState(entry, 'connecting', '正在连接这个镜头，首次通常需要 5～20 秒…');
  try {
    const r = await api('/api/stream', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: camera.did, channel: entry.channel, quality }),
    });
    if (!active()) return;
    const player = document.createElement('video-rtc');
    entry.player = player;
    player.mode = 'webrtc,mse';
    player.pcConfig = { bundlePolicy: 'max-bundle', iceServers: [], sdpSemantics: 'unified-plan' };
    entry.shell.prepend(player);
    player.video.addEventListener('playing', () => {
      if (!active()) return;
      clearTimeout(entry.playTimer);
      setLensState(entry, 'playing');
    });
    player.video.addEventListener('error', () => {
      if (!active()) return;
      if (player.wsState === WebSocket.CLOSED && player.pcState === WebSocket.CLOSED) return;
      setLensState(entry, 'error', '画面播放失败，请重试此镜头。');
      stopLens(entry);
    });
    entry.playTimer = setTimeout(() => {
      if (!active()) return;
      setLensState(entry, 'error', '尚未收到这个镜头的画面，请确认摄像头网络正常，再单独重试。');
      stopLens(entry);
    }, 45000);
    player.src = r.ws;
  } catch (e) {
    if (active()) {
      setLensState(entry, 'error', e.name === 'AbortError' ? '连接超时，请重试此镜头。' : e.message);
      stopLens(entry);
    }
  } finally {
    clearTimeout(entry.requestTimer);
  }
}

function waitLensPlaying(entry, ms) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const timer = setInterval(() => {
      if (!players.includes(entry)) { clearInterval(timer); reject(new Error('页面已关闭')); return; }
      if (entry.state === 'playing') { clearInterval(timer); resolve(); return; }
      if (entry.state === 'error') { clearInterval(timer); reject(new Error('实时画面连接失败，无法读取存储卡录像')); return; }
      if (Date.now() > end) { clearInterval(timer); reject(new Error('连接摄像头超时，请返回实时后重试')); }
    }, 250);
  });
}

function canMoveMotor() {
  return Boolean(current?.ptz) && mode === 'live' && mainIsLive();
}

// 云台长按：协议层只有单步 operation，没有「转多久」这个参数，米家 App 的持续转动
// 就是按住期间不停补发单步指令。
const MOTOR_INTERVAL = 220;
// 卡键 / 触摸事件丢失时的兜底，最多连转 12 秒
const MOTOR_MAX_HOLD = 12000;

function setMotorStatus(text) {
  $('motorStatus').textContent = text;
}

const MOTOR_IDLE_HINT = '已停止，按住方向按钮或键盘 ↑ ↓ ← → 可继续转动。';
let motorError = '';

function stopMotorHold() {
  if (!motorHold) return;
  clearTimeout(motorHold.timer);
  clearTimeout(motorHold.guard);
  motorHold.pad?.classList.remove('is-holding');
  motorHold = null;
  if (!motorPending) setMotorStatus(motorError || MOTOR_IDLE_HINT);
  // 兜底：最后一条指令万一卡在网络里，1 秒后也把「正在转动」收掉
  clearTimeout(stopMotorHold.settle);
  stopMotorHold.settle = setTimeout(() => {
    if (!motorHold) setMotorStatus(motorError || MOTOR_IDLE_HINT);
  }, 1000);
}

function startMotorHold(direction, pad) {
  if (motorHold || !direction) return;
  if (!canMoveMotor()) return;
  motorError = '';
  clearTimeout(stopMotorHold.settle);
  motorHold = { direction, pad: pad || null, timer: null, guard: setTimeout(stopMotorHold, MOTOR_MAX_HOLD) };
  pad?.classList.add('is-holding');
  setMotorStatus('正在转动，松手即停…');
  pumpMotor();
}

// 上一条落地再排下一条：网络一慢也不会把指令堆在队列里，松手立刻就能停住
async function pumpMotor() {
  if (!motorHold) return;
  const direction = motorHold.direction;
  await pressMotor(direction);
  if (!motorHold || motorHold.direction !== direction) return;
  motorHold.timer = setTimeout(pumpMotor, MOTOR_INTERVAL);
}

async function pressMotor(direction) {
  if (!current) return;
  const camera = current;
  const generation = viewGeneration;
  const active = () => current === camera && viewGeneration === generation;
  motorPending++;
  try {
    await api('/api/motor', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: camera.did, direction }),
    });
  } catch (e) {
    motorError = e.message;
    stopMotorHold();
    if (active()) setMotorStatus(e.message);
  } finally {
    motorPending--;
    // 松手时最后一条可能还在飞，等它落地再把状态收干净
    if (!motorPending && !motorHold && active()) setMotorStatus(motorError || MOTOR_IDLE_HINT);
  }
}

for (const button of motorButtons) {
  const direction = button.dataset.direction;
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || button.disabled) return;
    e.preventDefault();
    // 指针捕获：手指/鼠标滑出按钮范围也不会丢 pointerup
    try { button.setPointerCapture(e.pointerId); } catch {}
    startMotorHold(direction, button);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    button.addEventListener(type, stopMotorHold);
  }
  // 键盘聚焦在按钮上时，空格/回车会触发 click，这里不再走 click 逻辑
  button.addEventListener('click', (e) => e.preventDefault());
}
window.addEventListener('pointerup', stopMotorHold);
window.addEventListener('blur', stopMotorHold);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMotorHold();
});

// ---------- 画质 ----------

const QUALITY_KEY = 'mi-home-quality';
const QUALITY_LABEL = { auto: '自动', sd: '360p', max: '最高画质' };

function loadQuality() {
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    return ['auto', 'sd', 'max'].includes(saved) ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

function saveQuality(value) {
  try { localStorage.setItem(QUALITY_KEY, value); } catch {}
}

function qualityMaxLabel() {
  return current?.quality?.maxLabel || '2K';
}

function renderQualityChrome() {
  const box = $('qualitySwitch');
  if (!box) return;
  $('qualityMaxBtn').textContent = qualityMaxLabel();
  box.hidden = mode !== 'live' || !current;
  for (const btn of box.querySelectorAll('[data-quality]')) {
    btn.classList.toggle('active', btn.dataset.quality === quality);
    btn.disabled = qualityBusy;
  }
}

function noteQuality(text) {
  const note = $('qualityNote');
  if (!note) return;
  note.textContent = text;
  clearTimeout(noteQuality.timer);
  noteQuality.timer = setTimeout(() => { note.textContent = ''; }, 4500);
}

// 画质是会话内的切换：go2rtc 把 videoquality 下发给摄像头，画面不断流，新档位从下一个关键帧生效
async function changeQuality(next, { silent = false } = {}) {
  if (!current || qualityBusy) return;
  if (next === quality && !silent) return;
  const camera = current;
  const generation = viewGeneration;
  const active = () => current === camera && viewGeneration === generation;
  const previous = quality;
  qualityBusy = true;
  quality = next;
  renderQualityChrome();
  try {
    await api('/api/quality', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: camera.did, quality: next }),
    });
    saveQuality(next);
    if (active() && !silent) {
      const label = next === 'max' ? qualityMaxLabel() : QUALITY_LABEL[next];
      // 镜头 2 的档位只能建流时定，运行中切不动
      const dual = (camera.lenses?.length || 0) > 1;
      noteQuality(`已切到${label}，画面会在下一个关键帧生效` + (dual ? '；镜头 2 点「重试此镜头」后跟着变' : ''));
    }
  } catch (e) {
    quality = previous;
    // 静默补发（画面刚起来时）失败不打扰用户：可能是这个镜头的档位还没就绪
    if (active() && !silent) {
      noteQuality('切换画质失败：' + e.message);
      modal('切换画质失败', e.message);
    }
  } finally {
    qualityBusy = false;
    if (active()) renderQualityChrome();
  }
}

for (const btn of $('qualitySwitch').querySelectorAll('[data-quality]')) {
  btn.addEventListener('click', () => changeQuality(btn.dataset.quality));
}

$('reloadBtn').onclick = () => {
  if (!current) return;
  if (mode === 'replay') {
    if (!dateInfo()) startReplaySession();
    else playReplayAt(replay.time, { text: '正在重新定位…' });
  } else {
    players.forEach(connectLens);
  }
};

function closePlayer() {
  stopMotorHold();
  viewGeneration++;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (mode === 'replay') saveMemory();
  mode = 'live';
  replay.opToken++;
  stopReplayStream();
  stopReplayFeed();
  replay.loading = false;
  replay.playing = false;
  replay.dragging = false;
  replay.ended = false;
  replay.error = null;
  replay.windowEnd = 0;
  clearFreezeFrame();
  hideLoading();
  hideError();
  $('pauseLayer').hidden = true;
  $('scrubLayer').hidden = true;
  $('track').classList.remove('invalid');
  stage.classList.remove('scrubbing', 'is-paused');
  replayDates = [];
  replayListAt = 0;
  liveSuspended = false;
  destroyPlayer();
  current = null;
  motorPending = 0;
  qualityBusy = false;
  replayView.hidden = true;
  liveView.hidden = false;
  $('dateRow').replaceChildren();
  $('runs').replaceChildren();
  $('segTicks').replaceChildren();
  $('gapLabels').replaceChildren();
  $('ovRuns').replaceChildren();
  $('ruler').replaceChildren();
  $('playhead').style.left = '0%';
  $('motorPanel').hidden = true;
  if (!$('logoutBtn').hidden) show('home');
}
$('closePlayer').onclick = closePlayer;

// ---------- 回放：数据与时间轴 ----------

function dateInfo() {
  return replayDates[replay.dateIndex] || null;
}

function buildReplayDates(items) {
  const buckets = new Map();
  for (const item of items) {
    if (!Number.isInteger(item.start) || item.start <= 0) continue;
    if (!Number.isInteger(item.duration) || item.duration <= 0 || item.duration > MAX_WINDOW) continue;
    const key = dateKeyOf(item.start);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ start: item.start, duration: item.duration });
  }
  const dates = [];
  for (const [key, segments] of buckets) {
    segments.sort((a, b) => a.start - b.start);
    const runs = [];
    for (const segment of segments) {
      const end = segment.start + segment.duration;
      const last = runs[runs.length - 1];
      if (last && segment.start <= last[1] + GAP_TOLERANCE) {
        last[1] = Math.max(last[1], end);
      } else {
        runs.push([segment.start, end]);
      }
    }
    dates.push({
      key,
      dayStart: dayStartOfKey(key),
      segments,
      runs,
      total: runs.reduce((n, [a, b]) => n + (b - a), 0),
    });
  }
  dates.sort((a, b) => (a.key < b.key ? 1 : -1));
  return dates;
}

function findRun(d, t) {
  const run = d.runs.find(([a, b]) => t >= a && t < b) || null;
  return run;
}

function recordedAt(d, t) {
  return !!findRun(d, t);
}

function segmentAt(d, t) {
  let lo = 0;
  let hi = d.segments.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = d.segments[mid];
    if (segment.start <= t) {
      best = segment;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best && t < best.start + best.duration ? best : null;
}

function segmentEnd(segment) {
  return segment.start + segment.duration;
}

function nearestSegment(d, t) {
  let best = null;
  let bestDelta = Infinity;
  for (const segment of d.segments) {
    const candidate = t < segment.start ? segment.start
      : t >= segmentEnd(segment) ? segmentEnd(segment) - 0.2 : t;
    const delta = Math.abs(candidate - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = { segment, time: candidate };
    }
  }
  return best;
}

function resolveSeek(d, t) {
  const time = clamp(t, d.dayStart, d.dayStart + DAY - 1);
  const segment = segmentAt(d, time);
  if (segment) return { segment, time };
  const near = nearestSegment(d, time);
  if (!near) return null;
  return { segment: near.segment, time: near.time };
}

function nextSegment(d, t) {
  const inside = segmentAt(d, t);
  if (inside) return inside;
  const next = d.segments.find((segment) => segment.start >= t);
  if (next && next.start - t <= GAP_TOLERANCE + 1) return next;
  return null;
}

function nextRunStart(d, t) {
  let best = null;
  for (const [a] of d.runs) {
    if (a >= t && (best === null || a < best)) best = a;
  }
  return best;
}

function defaultPosition(d) {
  if (!d.runs.length) return d.dayStart;
  const run = d.runs[d.runs.length - 1];
  const target = Math.max(run[0], run[1] - 10 * M);
  return resolveSeek(d, target)?.time ?? run[0];
}

function windowFor(d, segment, time) {
  const offset = Math.max(0, Math.floor(time - segment.start));
  const run = findRun(d, segment.start) || [segment.start, segmentEnd(segment)];
  const runEnd = Math.max(segmentEnd(segment), run[1]);
  const duration = Math.min(MAX_WINDOW, Math.max(offset + 1, Math.round(runEnd - segment.start)));
  return { offset, duration, end: segment.start + duration };
}

function viewRange() {
  const d = dateInfo();
  if (!d) return { start: 0, span: DAY };
  const span = replay.zoom === 'day' ? DAY : replay.zoom === '6h' ? 6 * H : H;
  if (replay.zoom === 'day') return { start: d.dayStart, span: DAY };
  const start = clamp(replay.anchor - span / 2, d.dayStart, d.dayStart + DAY - span);
  return { start, span };
}

function hourCoverage(d, hour) {
  const from = d.dayStart + hour * H;
  const to = from + H;
  let sec = 0;
  for (const [a, b] of d.runs) sec += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return clamp(sec / H, 0, 1);
}

function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function showLoading(text) {
  $('loadingText').textContent = text;
  $('loadingLayer').hidden = false;
  $('scrubLayer').hidden = true;
  $('pauseLayer').hidden = true;
  $('errorLayer').hidden = true;
}

function hideLoading() {
  $('loadingLayer').hidden = true;
}

function showError(text) {
  $('errorText').textContent = text;
  $('errorLayer').hidden = false;
  $('loadingLayer').hidden = true;
  $('pauseLayer').hidden = true;
}

function hideError() {
  $('errorLayer').hidden = true;
}

function paintRuns(container, range, className, d) {
  container.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const [a, b] of d.runs) {
    const start = Math.max(a, range.start);
    const end = Math.min(b, range.start + range.span);
    if (end <= start) continue;
    const el = document.createElement('div');
    el.className = className;
    el.style.left = ((start - range.start) / range.span * 100) + '%';
    el.style.width = Math.max(0.08, (end - start) / range.span * 100) + '%';
    el.title = `${fmt(a)} – ${fmt(b)}`;
    frag.append(el);
  }
  container.append(frag);
}

function renderRuler(range, d) {
  const ruler = $('ruler');
  ruler.replaceChildren();
  const minor = replay.zoom === 'day' ? H : replay.zoom === '6h' ? 30 * M : 5 * M;
  const major = replay.zoom === 'day' ? 3 * H : replay.zoom === '6h' ? H : 10 * M;
  const begin = d.dayStart + Math.ceil((range.start - d.dayStart) / minor) * minor;
  for (let t = begin; t <= range.start + range.span + 0.5; t += minor) {
    const pct = (t - range.start) / range.span * 100;
    if (pct < -0.5 || pct > 100.5) continue;
    const isMajor = (t - d.dayStart) % major === 0;
    const tick = document.createElement('span');
    tick.className = 'r-tick' + (isMajor ? ' major' : '');
    tick.style.left = pct + '%';
    ruler.append(tick);
    if (isMajor) {
      const label = document.createElement('span');
      label.className = 'r-label';
      label.textContent = t >= d.dayStart + DAY ? '24:00' : fmt(t).slice(0, 5);
      label.style.left = pct + '%';
      label.style.transform = pct > 92 ? 'translateX(-100%)' : pct < 4 ? 'none' : 'translateX(-50%)';
      ruler.append(label);
    }
  }
}

function renderSegmentTicks(range, d) {
  const layer = $('segTicks');
  layer.replaceChildren();
  if (replay.zoom !== '1h') return;
  const begin = d.dayStart + Math.ceil((range.start - d.dayStart) / M) * M;
  for (let t = begin; t < range.start + range.span; t += M) {
    if (!segmentAt(d, t)) continue;
    const el = document.createElement('span');
    el.className = 'seg-tick';
    el.style.left = ((t - range.start) / range.span * 100) + '%';
    layer.append(el);
  }
}

function renderGaps(range, d) {
  const layer = $('gapLabels');
  layer.replaceChildren();
  const gaps = [];
  let prev = d.dayStart;
  for (const [a, b] of d.runs) {
    if (a > prev) gaps.push([prev, a]);
    prev = Math.max(prev, b);
  }
  if (prev < d.dayStart + DAY) gaps.push([prev, d.dayStart + DAY]);
  const width = track.clientWidth || 900;
  for (const [a, b] of gaps) {
    const start = Math.max(a, range.start);
    const end = Math.min(b, range.start + range.span);
    if (end <= start) continue;
    if ((end - start) / range.span * width < 48) continue;
    const el = document.createElement('span');
    el.className = 'gap-label';
    el.textContent = '无录像';
    el.title = `${fmt(a)} – ${fmt(b)} 无录像`;
    el.style.left = ((start + end) / 2 - range.start) / range.span * 100 + '%';
    layer.append(el);
  }
}

function placePlayhead() {
  const d = dateInfo();
  if (!d) return;
  const range = viewRange();
  const pct = clamp((replay.time - range.start) / range.span, 0, 1);
  $('playhead').style.left = pct * 100 + '%';
  $('ovHead').style.left = clamp((replay.time - d.dayStart) / DAY, 0, 1) * 100 + '%';
  track.setAttribute('aria-valuenow', String(Math.round(replay.time - d.dayStart)));
  track.setAttribute('aria-valuetext', `${fmt(replay.time)}${recordedAt(d, replay.time) ? ' 有录像' : ' 无录像'}`);
}

function renderOverviewWindow(d) {
  const win = $('ovWindow');
  if (replay.zoom === 'day') { win.hidden = true; return; }
  win.hidden = false;
  const range = viewRange();
  win.style.left = ((range.start - d.dayStart) / DAY * 100) + '%';
  win.style.width = (range.span / DAY * 100) + '%';
}

function renderTimeline() {
  const d = dateInfo();
  if (!d) return;
  $('tlSub').textContent = `${d.key} ${weekdayOf(d.key)} · 共 ${dur(d.total)}`;
  paintRuns($('ovRuns'), { start: d.dayStart, span: DAY }, 'ov-run', d);
  renderOverviewWindow(d);
  const range = viewRange();
  renderRuler(range, d);
  paintRuns($('runs'), range, 'run', d);
  renderSegmentTicks(range, d);
  renderGaps(range, d);
  placePlayhead();
}

function renderDatePills() {
  const row = $('dateRow');
  row.replaceChildren();
  const now = Math.floor(Date.now() / 1000);
  const today = dateKeyOf(now);
  const yesterday = dateKeyOf(now - DAY);
  replayDates.forEach((d, index) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'date-pill';
    b.title = `${d.key} ${weekdayOf(d.key)} · 共 ${dur(d.total)}`;
    const top = document.createElement('span');
    top.className = 'dp-top';
    top.textContent = d.key === today ? '今天' : d.key === yesterday ? '昨天' : weekdayOf(d.key);
    const dateEl = document.createElement('span');
    dateEl.className = 'dp-date';
    dateEl.textContent = d.key.slice(5);
    const spark = document.createElement('span');
    spark.className = 'spark';
    for (let h = 0; h < 24; h++) {
      const bar = document.createElement('i');
      const cov = hourCoverage(d, h);
      if (cov > 0) {
        bar.className = 'on';
        bar.style.opacity = String(0.35 + 0.65 * cov);
      }
      spark.append(bar);
    }
    b.append(top, dateEl, spark);
    b.addEventListener('click', () => selectReplayDate(index));
    row.append(b);
  });
  markDatePills();
}

function markDatePills() {
  const row = $('dateRow');
  [...row.children].forEach((b, i) => b.classList.toggle('active', i === replay.dateIndex));
  const active = row.children[replay.dateIndex];
  if (active) row.scrollLeft = Math.max(0, active.offsetLeft - row.offsetLeft - 8);
}

// ---------- 回放：控制器 ----------

function setModeChrome() {
  const isReplay = mode === 'replay';
  $('modeLiveBtn').classList.toggle('active', !isReplay);
  $('modeReplayBtn').classList.toggle('active', isReplay);
  liveView.hidden = isReplay;
  replayView.hidden = !isReplay;
  $('playerMeta').textContent = current ? `${current.model || ''}${isReplay ? ' · 存储卡回放' : ' · 实时画面'}` : '';
  $('reloadBtn').textContent = isReplay ? '重新定位' : '重新连接';
  renderQualityChrome();
  if (isReplay) updateReplayChrome();
  else updatePlayerState();
}

function updateReplayChrome() {
  if (mode !== 'replay') return;
  $('playBtn').innerHTML = replay.playing ? ICON_PAUSE : ICON_PLAY;
  $('playBtn').setAttribute('aria-label', replay.playing ? '暂停' : '播放');
  $('muteBtn').innerHTML = replay.muted ? ICON_MUTE : ICON_VOLUME;
  $('muteBtn').setAttribute('aria-label', replay.muted ? '开启声音' : '静音');
  $('fsBtn').innerHTML = ICON_FS;
  $('pauseLayer').hidden = replay.playing || replay.loading || replay.dragging || !!replay.error;
  $('pauseText').textContent = replay.ended
    ? (replay.endedNext !== null ? '本段录像已结束，可继续下一段' : '当天录像已结束')
    : '已暂停';
  $('bigPlay').hidden = replay.ended && replay.endedNext === null;
  $('bigPlay').setAttribute('aria-label', replay.ended && replay.endedNext !== null ? '继续下一段' : '继续播放');
  stage.classList.toggle('is-paused', !replay.playing && !replay.loading);
  stage.classList.toggle('is-scrubbing', replay.dragging);
  streamState.textContent = replay.error ? '回放失败'
    : replay.loading ? '定位中…'
      : replay.playing ? '回放中'
        : replay.ended ? '已结束' : '已暂停';
  streamState.className = 'pill' + (replay.playing ? ' on' : replay.error ? ' off' : '');
  $('reloadBtn').disabled = replay.loading;
}

function updatePositions() {
  if (mode !== 'replay') return;
  const d = dateInfo();
  $('timeNow').textContent = d ? fmt(replay.time) : '--:--:--';
  const end = replay.windowEnd || (replay.seg ? segmentEnd(replay.seg) : 0);
  $('timeEnd').textContent = end ? fmt(end) : '--:--:--';
  if (!d) return;
  $('osd').textContent = `${d.key} ${fmt(replay.time)}`;
  placePlayhead();
  if (replay.playing && !replay.loading && Math.floor(replay.time) !== replay.statusSecond) refreshStatus();
}

function refreshStatus() {
  if (mode !== 'replay') return;
  const dot = $('statusDot');
  const remain = $('remainChip');
  const next = $('nextRunBtn');
  dot.classList.toggle('idle', !replay.playing);
  if (replay.loading) {
    $('statusText').textContent = '正在定位录像…';
    remain.hidden = true;
    next.hidden = true;
    return;
  }
  if (replay.error) {
    $('statusText').textContent = '定位失败 · ' + replay.error;
    remain.hidden = true;
    next.hidden = true;
    return;
  }
  if (replay.ended) {
    $('statusText').textContent = `本段录像已结束 · ${fmt(replay.time)}`;
    remain.hidden = true;
    next.hidden = replay.endedNext === null;
    if (replay.endedNext !== null) next.textContent = `继续 ${fmt(replay.endedNext)}`;
    return;
  }
  next.hidden = true;
  if (replay.playing) {
    $('statusText').textContent = `正在播放 · ${fmt(replay.time)} – ${fmt(replay.windowEnd)} · 镜头 1`;
    remain.hidden = false;
    remain.textContent = `距接续 ${mmss(replay.windowEnd - replay.time)}`;
  } else {
    $('statusText').textContent = `已暂停 · ${fmt(replay.time)} · 镜头 1`;
    remain.hidden = true;
  }
  replay.statusSecond = Math.floor(replay.time);
}

function saveMemory() {
  const d = dateInfo();
  if (!current || !d) return;
  const time = recordedAt(d, replay.time) ? replay.time : defaultPosition(d);
  const run = findRun(d, time);
  replayMemory.set(current.did, {
    dateKey: d.key,
    time: Math.floor(run ? Math.min(time, run[1] - 5) : time),
  });
}

function freezeReplayFrame() {
  const video = replay.player?.video;
  if (!video || !video.videoWidth) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.className = 'freeze-frame';
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    stage.querySelector('.freeze-frame')?.remove();
    stage.insertBefore(canvas, stage.querySelector('.stage-shade'));
  } catch {}
}

function clearFreezeFrame() {
  stage.querySelector('.freeze-frame')?.remove();
}

// 关闭前端 WebSocket 不会释放小米 P2P，需要让本地服务删掉这个回放流
function stopReplayFeed() {
  if (!current) return;
  fetch('/api/playback/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: current.did }),
    keepalive: true,
  }).catch(() => {});
}

function stopReplayStream() {
  clearTimeout(replay.loadTimer);
  replay.loadTimer = null;
  replay.requestController?.abort();
  replay.requestController = null;
  if (replay.player) {
    const player = replay.player;
    replay.player = null;
    clearTimeout(player.disconnectTID);
    clearTimeout(player.reconnectTID);
    player.disconnectTID = player.reconnectTID = 0;
    try { player.ondisconnect(); } catch {}
    player.remove();
  }
}

function maybeFollowView() {
  if (replay.zoom === 'day') return;
  const range = viewRange();
  if (replay.time < range.start || replay.time >= range.start + range.span) {
    replay.anchor = replay.time;
    renderTimeline();
  }
}

function replayTick() {
  if (!replay.playing || replay.loading || replay.dragging || replay.ended || replay.error) return;
  const t = replay.playFrom + (performance.now() - replay.wallStart) / 1000;
  if (t >= replay.windowEnd - 0.05) {
    replay.time = replay.windowEnd;
    updatePositions();
    continueReplay();
    return;
  }
  replay.time = t;
  maybeFollowView();
  updatePositions();
}

function continueReplay() {
  if (replay.switching || mode !== 'replay' || !replay.playing) return;
  const d = dateInfo();
  if (!d) return;
  const next = nextSegment(d, replay.windowEnd);
  if (next) {
    replay.switching = true;
    playReplayAt(Math.max(replay.windowEnd, next.start), { text: '正在接续下一段录像…' });
  } else {
    endReplay();
  }
}

function endReplay() {
  freezeReplayFrame();
  stopReplayStream();
  stopReplayFeed();
  replay.loading = false;
  replay.playing = false;
  replay.ended = true;
  replay.time = replay.windowEnd || replay.time;
  replay.endedNext = nextRunStart(dateInfo(), replay.time);
  replay.seg = null;
  updateReplayChrome();
  updatePositions();
  refreshStatus();
  saveMemory();
  if (replay.endedNext === null) showToast('当天录像已结束，可以切换到其他日期');
}

function failReplay(text) {
  stopReplayStream();
  stopReplayFeed();
  replay.loading = false;
  replay.playing = false;
  replay.ended = false;
  replay.error = text;
  showError(text);
  updateReplayChrome();
  refreshStatus();
}

async function playReplayAt(target, options = {}) {
  if (mode !== 'replay' || !current) return;
  const d = dateInfo();
  if (!d) return;
  const resolved = resolveSeek(d, target);
  if (!resolved) { showToast('当天没有可播放的录像'); return; }
  const segment = resolved.segment;
  const time = resolved.time;
  const win = windowFor(d, segment, time);
  stopReplayStream();
  const token = ++replay.opToken;
  replay.loading = true;
  replay.playing = false;
  replay.ended = false;
  replay.endedNext = null;
  replay.error = null;
  replay.errorAction = 'play';
  replay.switching = false;
  replay.time = time;
  replay.seg = segment;
  replay.windowEnd = win.end;
  replay.statusSecond = -1;
  if (replay.zoom !== 'day') {
    const range = viewRange();
    if (time < range.start || time >= range.start + range.span) {
      replay.anchor = time;
      renderTimeline();
    }
  }
  showLoading(options.text || `正在定位到 ${fmt(time)}…`);
  updateReplayChrome();
  updatePositions();
  refreshStatus();
  saveMemory();
  const controller = new AbortController();
  replay.requestController = controller;
  const requestTimer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await api('/api/playback', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        did: current.did,
        channel: '0',
        start: segment.start,
        offset: win.offset,
        duration: win.duration,
      }),
    });
    clearTimeout(requestTimer);
    if (token !== replay.opToken || mode !== 'replay') return;
    const player = document.createElement('video-rtc');
    replay.player = player;
    player.mode = 'webrtc,mse';
    player.pcConfig = { bundlePolicy: 'max-bundle', iceServers: [], sdpSemantics: 'unified-plan' };
    player.visibilityCheck = false;
    player.background = true;
    stage.prepend(player);
    player.video.controls = false;
    player.video.playsInline = true;
    player.video.muted = replay.muted;
    const up = () => {
      if (token !== replay.opToken || mode !== 'replay') return;
      clearTimeout(replay.loadTimer);
      clearFreezeFrame();
      hideLoading();
      hideError();
      if (!replay.playing) {
        replay.playing = true;
        replay.loading = false;
        replay.playFrom = time;
        replay.wallStart = performance.now();
        replay.windowEnd = win.end;
      }
      updateReplayChrome();
      updatePositions();
      refreshStatus();
    };
    player.video.addEventListener('playing', up);
    player.video.addEventListener('error', () => {
      if (token !== replay.opToken || mode !== 'replay') return;
      if (player.wsState === WebSocket.CLOSED && player.pcState === WebSocket.CLOSED) return;
      failReplay('回放画面播放失败，请重试');
    });
    replay.loadTimer = setTimeout(() => {
      if (token !== replay.opToken || replay.playing) return;
      failReplay('25 秒内没有收到回放画面，请重试');
    }, 25000);
    player.src = r.ws;
  } catch (e) {
    clearTimeout(requestTimer);
    if (token !== replay.opToken || mode !== 'replay') return;
    const message = e.name === 'AbortError' ? '请求回放超时，请重试' : e.message;
    if (/过期/.test(message)) {
      replayListAt = 0;
      replay.errorAction = 'load';
    }
    failReplay(message);
  }
}

function pauseReplay() {
  if (mode !== 'replay' || replay.loading || replay.dragging) return;
  freezeReplayFrame();
  stopReplayStream();
  stopReplayFeed();
  replay.playing = false;
  replay.time = replay.windowEnd
    ? clamp(replay.time, replay.playFrom, replay.windowEnd)
    : replay.time;
  updateReplayChrome();
  updatePositions();
  refreshStatus();
  saveMemory();
}

function togglePlay() {
  if (mode !== 'replay' || replay.loading || replay.dragging) return;
  if (replay.playing) { pauseReplay(); return; }
  if (replay.ended) {
    if (replay.endedNext !== null) {
      playReplayAt(replay.endedNext, { text: `正在定位到 ${fmt(replay.endedNext)}…` });
    } else {
      showToast('当天录像已结束，可以切换到其他日期');
    }
    return;
  }
  if (replay.error) {
    playReplayAt(replay.time, { text: '正在重试…' });
    return;
  }
  playReplayAt(replay.time, { text: '正在恢复播放…' });
}

function skip(delta) {
  if (mode !== 'replay' || replay.loading || replay.dragging) return;
  const d = dateInfo();
  if (!d) return;
  let t = replay.time + delta;
  if (!segmentAt(d, t)) {
    if (delta > 0) {
      const next = d.segments.find((segment) => segment.start >= t);
      t = next ? next.start : resolveSeek(d, t)?.time;
    } else {
      let prev = null;
      for (const segment of d.segments) {
        if (segmentEnd(segment) <= t) prev = segment;
        else break;
      }
      t = prev ? segmentEnd(prev) - 0.5 : resolveSeek(d, t)?.time;
    }
  }
  if (t == null) return;
  playReplayAt(t, { text: `正在定位到 ${fmt(t)}…` });
}

function exitReplayMode() {
  if (mode !== 'replay') return;
  saveMemory();
  mode = 'live';
  replay.opToken++;
  stopReplayStream();
  stopReplayFeed();
  replay.loading = false;
  replay.playing = false;
  replay.dragging = false;
  replay.ended = false;
  replay.error = null;
  replay.windowEnd = 0;
  clearFreezeFrame();
  hideLoading();
  hideError();
  $('pauseLayer').hidden = true;
  $('scrubLayer').hidden = true;
  $('track').classList.remove('invalid');
  stage.classList.remove('scrubbing', 'is-paused');
  setModeChrome();
  if (liveSuspended) {
    liveSuspended = false;
    players.forEach(connectLens);
  }
}

function suspendLive() {
  for (const entry of players) {
    stopLens(entry);
    entry.state = 'idle';
    entry.status.textContent = '已暂停';
    entry.status.className = 'pill';
    entry.overlay.hidden = false;
    entry.overlay.querySelector('.spinner').hidden = true;
    entry.overlay.querySelector('p').textContent = '回放中，返回实时后重新连接';
    entry.retry.disabled = false;
  }
  liveSuspended = true;
}

async function fetchRecordings() {
  return api('/api/recordings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: current.did }),
  });
}

async function ensureReplayData() {
  if (replayDates.length && Date.now() - replayListAt < 2 * 60 * 1000) return;
  const entry = players.find((item) => String(item.channel) === '0');
  if (!entry) throw new Error('没有可用的镜头');
  if (!mainIsLive()) {
    if (entry.state !== 'connecting') connectLens(entry);
    await waitLensPlaying(entry, 45000);
  }
  let r;
  try {
    r = await fetchRecordings();
  } catch (e) {
    if (!/先连接实时|超时/.test(e.message || '')) throw e;
    connectLens(entry);
    await waitLensPlaying(entry, 60000);
    r = await fetchRecordings();
  }
  if (mode !== 'replay' || !current) return;
  if (!Array.isArray(r.recordings)) throw new Error('服务没有返回有效的录像列表');
  const dates = buildReplayDates(r.recordings);
  if (!dates.length) throw new Error('存储卡里没有读到可播放的录像');
  replayDates = dates;
  replayListAt = Date.now();
}

async function startReplaySession() {
  if (mode !== 'replay' || !current) return;
  const camera = current;
  const generation = viewGeneration;
  hideError();
  replay.error = null;
  replay.errorAction = 'load';
  replay.loading = true;
  replay.playing = false;
  replay.ended = false;
  showLoading('正在读取存储卡录像…');
  updateReplayChrome();
  refreshStatus();
  try {
    await ensureReplayData();
    if (mode !== 'replay' || current !== camera || generation !== viewGeneration) return;
    suspendLive();
    const memory = replayMemory.get(camera.did);
    let index = 0;
    if (memory) {
      const i = replayDates.findIndex((d) => d.key === memory.dateKey);
      if (i >= 0) index = i;
    }
    replay.dateIndex = index;
    const d = replayDates[index];
    let target = null;
    if (memory && memory.dateKey === d.key) target = resolveSeek(d, memory.time)?.time ?? null;
    if (target == null) target = defaultPosition(d);
    replay.time = target;
    replay.anchor = target;
    renderDatePills();
    renderTimeline();
    await playReplayAt(target);
  } catch (e) {
    if (mode !== 'replay' || current !== camera) return;
    replay.errorAction = 'load';
    failReplay(e.message);
  }
}

async function enterReplayMode() {
  if (!current || mode === 'replay') return;
  if (!replaySupported()) {
    modal('暂不支持回放', '这台机型的存储卡回放尚未接通。');
    return;
  }
  mode = 'replay';
  replay.zoom = '1h';
  document.querySelectorAll('[data-zoom]').forEach((b) => b.classList.toggle('active', b.dataset.zoom === '1h'));
  replay.playing = false;
  replay.loading = false;
  replay.dragging = false;
  replay.ended = false;
  replay.error = null;
  replay.windowEnd = 0;
  hideError();
  hideLoading();
  $('pauseLayer').hidden = true;
  $('scrubLayer').hidden = true;
  $('tlSub').textContent = '正在读取录像列表…';
  setModeChrome();
  await startReplaySession();
}

async function selectReplayDate(index) {
  if (mode !== 'replay') return;
  const d = replayDates[index];
  if (!d || index === replay.dateIndex) return;
  replay.dateIndex = index;
  markDatePills();
  const now = Math.floor(Date.now() / 1000);
  let target = null;
  if (index === 0) {
    target = defaultPosition(d);
  } else if (replay.time) {
    const tod = replay.time - dayStartOfKey(dateKeyOf(replay.time));
    target = resolveSeek(d, d.dayStart + tod)?.time ?? null;
  }
  if (target == null) target = defaultPosition(d);
  replay.time = target;
  replay.anchor = target;
  renderTimeline();
  await playReplayAt(target, { text: `正在读取 ${d.key} 的录像…` });
}

function pointerTime(event) {
  const d = dateInfo();
  if (!d) return 0;
  const rect = track.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 0.99999);
  const range = viewRange();
  return clamp(Math.round(range.start + ratio * range.span), d.dayStart, d.dayStart + DAY - 1);
}

function updateDrag(event) {
  const d = dateInfo();
  if (!d) return;
  const t = pointerTime(event);
  const valid = recordedAt(d, t);
  replay.time = t;
  placePlayhead();
  $('timeNow').textContent = fmt(t);
  $('scrubLayer').textContent = valid ? `松手定位到 ${fmt(t)}` : `${fmt(t)} · 无录像`;
  $('scrubLayer').classList.toggle('bad', !valid);
  track.classList.toggle('invalid', !valid);
  $('statusText').textContent = valid ? `拖动定位 · ${fmt(t)}` : `拖动定位 · ${fmt(t)}（无录像）`;
  $('remainChip').hidden = true;
  $('nextRunBtn').hidden = true;
  $('statusDot').classList.add('idle');
}

function restoreAfterDrag() {
  replay.playing = replay.dragWasPlaying;
  if (replay.playing) {
    replay.time = clamp(
      replay.playFrom + (performance.now() - replay.wallStart) / 1000,
      replay.playFrom,
      replay.windowEnd,
    );
  } else {
    replay.time = replay.dragOrigin;
  }
  updateReplayChrome();
  updatePositions();
  refreshStatus();
}

function finishDrag(canceled) {
  if (!replay.dragging) return;
  replay.dragging = false;
  stage.classList.remove('scrubbing');
  $('scrubLayer').hidden = true;
  track.classList.remove('invalid');
  const d = dateInfo();
  if (!canceled && d && recordedAt(d, replay.time)) {
    playReplayAt(replay.time);
    return;
  }
  if (!canceled) showToast('这个时段没有录像，已退回原来的位置');
  restoreAfterDrag();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else stageCard.requestFullscreen?.().catch(() => {});
}

// ---------- 事件绑定 ----------

$('modeLiveBtn').onclick = () => { if (mode === 'replay') exitReplayMode(); };
$('modeReplayBtn').onclick = () => { enterReplayMode(); };
$('playBtn').onclick = togglePlay;
$('bigPlay').onclick = (e) => { e.stopPropagation(); togglePlay(); };
$('backBtn').onclick = () => skip(-30);
$('fwdBtn').onclick = () => skip(30);
$('liveBtn').onclick = exitReplayMode;
$('fsBtn').onclick = toggleFullscreen;
$('muteBtn').onclick = () => {
  replay.muted = !replay.muted;
  if (replay.player) replay.player.video.muted = replay.muted;
  updateReplayChrome();
};
$('nextRunBtn').onclick = () => {
  if (replay.endedNext === null) return;
  playReplayAt(replay.endedNext, { text: `正在定位到 ${fmt(replay.endedNext)}…` });
};
$('errorRetry').onclick = () => {
  if (mode !== 'replay') return;
  if (replay.errorAction === 'load') startReplaySession();
  else playReplayAt(replay.time, { text: '正在重试…' });
};
$('errorLive').onclick = exitReplayMode;

document.querySelectorAll('[data-zoom]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (mode !== 'replay' || btn.dataset.zoom === replay.zoom) return;
    replay.zoom = btn.dataset.zoom;
    replay.anchor = replay.time;
    document.querySelectorAll('[data-zoom]').forEach((b) => b.classList.toggle('active', b === btn));
    renderTimeline();
    updatePositions();
  });
});

stage.addEventListener('click', (e) => {
  if (mode !== 'replay' || replay.loading || replay.dragging || replay.error) return;
  if (e.target.closest('.controls, .cam-hud, .error-layer, .loading-layer')) return;
  togglePlay();
});

$('ovTrack').addEventListener('pointerdown', (e) => {
  if (mode !== 'replay' || replay.loading) return;
  const d = dateInfo();
  if (!d) return;
  const rect = $('ovTrack').getBoundingClientRect();
  const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 0.99999);
  const raw = d.dayStart + ratio * DAY;
  const near = resolveSeek(d, raw);
  if (!near) return;
  if (!recordedAt(d, Math.floor(raw))) showToast(`已跳到最近的录像 ${fmt(near.time)}`);
  playReplayAt(near.time);
});

track.addEventListener('pointerdown', (e) => {
  if (mode !== 'replay' || replay.loading) return;
  e.preventDefault();
  track.setPointerCapture?.(e.pointerId);
  replay.dragging = true;
  replay.dragWasPlaying = replay.playing;
  replay.dragOrigin = replay.time;
  replay.playing = false;
  replay.ended = false;
  replay.endedNext = null;
  replay.error = null;
  stage.classList.add('scrubbing');
  $('scrubLayer').hidden = false;
  $('pauseLayer').hidden = true;
  updateDrag(e);
});
track.addEventListener('pointermove', (e) => {
  if (!replay.dragging) return;
  updateDrag(e);
});
track.addEventListener('pointerup', () => finishDrag(false));
track.addEventListener('pointercancel', () => finishDrag(true));

const MOTOR_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

document.addEventListener('keydown', (e) => {
  if (playerView.hidden) return;
  const tag = e.target?.tagName || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
  if (e.code === 'Space') {
    if (mode !== 'replay') return;
    e.preventDefault();
    togglePlay();
  } else if (MOTOR_KEYS[e.key]) {
    if (mode === 'replay') {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        skip(e.key === 'ArrowLeft' ? -30 : 30);
      }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!$('modal').hidden || !canMoveMotor()) return;
    e.preventDefault();
    // 系统自带的按键重复不参与：按住由定时器统一补发，节奏才稳，松手也停得干净
    if (e.repeat) return;
    const direction = MOTOR_KEYS[e.key];
    if (motorHold && motorHold.direction !== direction) stopMotorHold();
    startMotorHold(direction);
  } else if (e.key === 'Escape' && !document.fullscreenElement) {
    if (mode === 'replay') exitReplayMode();
    else closePlayer();
  }
});

document.addEventListener('keyup', (e) => {
  const direction = MOTOR_KEYS[e.key];
  if (direction && motorHold?.direction === direction) stopMotorHold();
});

window.addEventListener('pagehide', () => {
  if (mode === 'replay') stopReplayFeed();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (mode === 'replay') {
      const d = dateInfo();
      if (d) renderGaps(viewRange(), d);
    }
  }, 150);
});

function loop() {
  if (mode === 'replay') replayTick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

loadState();
