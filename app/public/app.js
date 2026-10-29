import { VideoRTC } from './video-rtc.js';

customElements.define('video-rtc', VideoRTC);

const $ = (id) => document.getElementById(id);

const loginView = $('loginView');
const homeView = $('homeView');
const playerView = $('playerView');
const cameraGrid = $('cameraGrid');
const emptyBox = $('emptyBox');
const shell = $('videoShell');
const overlay = $('videoOverlay');
const overlayText = $('overlayText');
const streamState = $('streamState');

let cameras = [];
let current = null;
let player = null;

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

function setOverlay(text, spinner = true) {
  overlay.hidden = !text;
  overlay.querySelector('.spinner').style.display = spinner ? '' : 'none';
  overlayText.textContent = text || '';
}

function destroyPlayer() {
  if (!player) return;
  player.ondisconnect();
  player.remove();
  player = null;
}

async function openPlayer(cam) {
  current = cam;
  $('playerTitle').textContent = cam.name || '摄像头';
  $('playerMeta').textContent = cam.model || '';
  show('player');
  await connect();
}

async function connect() {
  destroyPlayer();
  setOverlay('正在通过小米云端连接摄像头，首次大约 5～20 秒…');
  streamState.textContent = '连接云端通道…';
  streamState.className = 'pill';
  try {
    const r = await api('/api/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: current.did }),
    });
    streamState.textContent = '建立播放通道…';
    player = document.createElement('video-rtc');
    player.mode = 'webrtc,mse';
    // 播放器和本机服务在同一台电脑上，不需要外部 STUN 服务器
    player.pcConfig = { bundlePolicy: 'max-bundle', iceServers: [], sdpSemantics: 'unified-plan' };
    shell.prepend(player);
    player.video.addEventListener('playing', () => {
      streamState.textContent = '直播中';
      streamState.className = 'pill on';
      setOverlay('');
    });
    player.src = r.ws;
  } catch (e) {
    setOverlay('没能打开这台摄像头：\n' + e.message, false);
    streamState.textContent = '失败';
    streamState.className = 'pill off';
  }
}

$('reloadBtn').onclick = () => { if (current) connect(); };

function closePlayer() {
  destroyPlayer();
  current = null;
  if (!$('logoutBtn').hidden) show('home');
}
$('closePlayer').onclick = closePlayer;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !playerView.hidden) closePlayer();
});

loadState();
