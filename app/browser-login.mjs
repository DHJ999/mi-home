import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.MI_PROFILE || path.join(ROOT, '.edge-profile');
const PORT = Number(process.env.MI_CDP_PORT || 9333);
const APP_URL = process.env.MI_APP_URL || 'http://127.0.0.1:1990';
const LOGIN_URL = process.env.MI_LOGIN_URL || 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_locale=zh_CN';
const FETCH_PATTERN = process.env.MI_FETCH_PATTERN || '*.xiaomi.com/*';
const TIMEOUT_MS = 10 * 60 * 1000;

let job = { state: 'idle', message: '', cameras: null };
let hookToken = '';
let authState = { auth: null, authAt: 0 };

export function browserLoginState() {
  return { state: job.state, message: job.message, cameras: job.cameras };
}

export function browserLoginHookToken() {
  return hookToken;
}

export function beginBrowserLogin({ onAccount }) {
  if (job.state === 'launching' || job.state === 'waiting') return;
  job = { state: 'launching', message: '正在打开小米登录窗口…', cameras: null };
  runLogin(onAccount).catch((e) => {
    const msg = e?.message || String(e);
    log('失败：' + msg);
    job = { state: 'error', message: msg, cameras: null };
  });
}

function log(...args) {
  console.log('[小米登录]', new Date().toLocaleTimeString('zh-CN'), ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function edgePath() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('没找到 Edge 或 Chrome，请先安装其中一个浏览器');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || '浏览器协议错误'));
        else p.resolve(msg.result || {});
        return;
      }
      for (const fn of this.handlers) fn(msg);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('登录窗口已关闭'));
      this.pending.clear();
      for (const fn of this.handlers) fn({ method: '__closed' });
    };
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('登录窗口已关闭'));
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`浏览器操作超时：${method}`));
      }, 20000);
    });
  }

  on(fn) {
    this.handlers.add(fn);
  }
}

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  throw new Error('浏览器没有成功启动，请关掉残留的登录窗口后重试');
}

async function closeExistingBrowser() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (!r.ok) return;
    const info = await r.json();
    const cdp = await connect(info.webSocketDebuggerUrl);
    log('发现残留的登录窗口，先关掉');
    await cdp.send('Browser.close').catch(() => {});
    await sleep(2000);
  } catch {}
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(new CDP(ws));
    ws.onerror = () => reject(new Error('连接浏览器调试端口失败'));
  });
}

function buildAccount(auth, cookies, serviceToken) {
  const get = (n) => (cookies.find((c) => c.name === n) || {}).value;
  return {
    sid: 'xiaomiio',
    deviceId: get('PassportDeviceId') || get('deviceId') || 'android_' + randomUUID(),
    userId: String(auth.userId || get('userId') || ''),
    serviceToken,
    pass: {
      ssecurity: auth.ssecurity,
      cUserId: String(auth.cUserId || get('cUserId') || ''),
      passToken: auth.passToken || get('passToken') || '',
      nonce: auth.nonce,
    },
  };
}

function parseAuthBody(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

function captureAuth(json, source) {
  if (!json) return false;
  if (json.ssecurity && !authState.auth) {
    authState.auth = json;
    authState.authAt = Date.now();
    log(`已捕获 ssecurity（${source}）`);
    return true;
  }
  return false;
}

export function ingestHookPayload(payload) {
  if (!payload || typeof payload.text !== 'string') return;
  captureAuth(parseAuthBody(payload.text), '页面上报');
}

function buildHookSource() {
  const url = `${APP_URL}/api/hook?t=${hookToken}`;
  return `(() => {
  try {
    if (window.__miHooked) return;
    window.__miHooked = true;
    window.__miAuth = [];
    const hookUrl = ${JSON.stringify(url)};
    const report = (u, t) => {
      try {
        if (!t || typeof t !== 'string') return;
        if (t.length > 20000) t = t.slice(0, 20000);
        window.__miAuth.push({ u: String(u || ''), t });
        if (window.__miAuth.length > 20) window.__miAuth.shift();
        if (/ssecurity|notificationUrl/.test(t) && navigator.sendBeacon) {
          navigator.sendBeacon(hookUrl, new Blob([JSON.stringify({ url: String(u || ''), text: t })], { type: 'text/plain' }));
        }
      } catch (e) {}
    };
    const of = window.fetch;
    if (of) {
      window.fetch = function () {
        const args = arguments;
        return of.apply(this, args).then(function (r) {
          try {
            const u = r.url || (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
            if (/xiaomi\\.com|mi\\.com/.test(u)) r.clone().text().then(function (t) { report(u, t); }).catch(function () {});
          } catch (e) {}
          return r;
        });
      };
    }
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { this.__miu = u; } catch (e) {}
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', function () {
          try {
            let t = '';
            try { t = this.responseText; } catch (e) { if (this.response) t = JSON.stringify(this.response); }
            if (typeof t === 'string') report(this.__miu || '', t);
          } catch (e) {}
        });
      } catch (e) {}
      return XS.apply(this, arguments);
    };
  } catch (e) {}
})();`;
}

async function runLogin(onAccount) {
  await closeExistingBrowser();
  await fsp.mkdir(PROFILE, { recursive: true });
  authState = { auth: null, authAt: 0 };
  hookToken = randomUUID();

  const proc = spawn(
    edgePath(),
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--hide-crash-restore-bubble',
      '--start-maximized',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  let targetId = null;
  try {
    const info = await waitForDevtools(25000);
    cdp = await connect(info.webSocketDebuggerUrl);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    const netSessions = new Set([sessionId]);
    const hookSource = buildHookSource();
    const enableNet = (sid) => {
      netSessions.add(sid);
      cdp.send('Network.enable', {}, sid).catch(() => {});
      cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hookSource }, sid).catch(() => {});
      cdp.send('Fetch.enable', { patterns: [{ urlPattern: FETCH_PATTERN, requestStage: 'Response' }] }, sid).catch(() => {});
      cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
    };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hookSource }, sessionId);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: FETCH_PATTERN, requestStage: 'Response' }] }, sessionId).catch(() => {});
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);

    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type === 'page' && t.targetId !== targetId) {
        cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      }
    }

    const { cookies: existing } = await cdp.send('Storage.getCookies').catch(() => ({ cookies: [] }));
    const keep = (existing || []).filter((c) => c.name === 'deviceId' || c.name === 'pass_ua');
    // 这台 Edge 的 CDP 没有 Storage.deleteCookies，必须整锅清掉，否则旧 passToken 会让小米直接 SSO，永远拿不到 ssecurity
    await cdp.send('Network.clearBrowserCookies', {}, sessionId);
    for (const c of keep) {
      await cdp
        .send('Network.setCookie', {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
        }, sessionId)
        .catch(() => {});
    }
    log(`已清空浏览器登录状态（保留设备标识 ${keep.length} 个），强制走密码登录`);

    job = { state: 'waiting', message: '请在弹出的浏览器窗口里用【账号密码】登录小米账号（扫码登录拿不到米家接口密钥）…', cameras: null };

    let verifiedPromptShown = false;
    let tokenAt = 0;
    let qrWarned = false;
    let nodeToken = '';
    let redeemTried = false;
    let windowGone = false;
    let goneAt = 0;
    const candidates = new Set();

    cdp.on(async (ev) => {
      try {
        if (ev.method === '__closed') {
          windowGone = true;
          goneAt = Date.now();
          log('浏览器连接已断开');
          return;
        }
        if (ev.method === 'Target.attachedToTarget' && ev.params?.sessionId) {
          enableNet(ev.params.sessionId);
          log('挂接新页面：' + (ev.params.targetInfo?.url || '').slice(0, 80));
          return;
        }
        if (ev.method === 'Target.targetDestroyed' && ev.params?.targetId === targetId) {
          windowGone = true;
          goneAt = Date.now();
          log('登录页标签被关闭');
          return;
        }
        if (!netSessions.has(ev.sessionId)) return;

        if (ev.method === 'Fetch.requestPaused') {
          const p = ev.params || {};
          try {
            if (p.responseStatusCode) {
              const r = await cdp.send('Fetch.getResponseBody', { requestId: p.requestId }, ev.sessionId);
              let body = r.body || '';
              if (r.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
              const json = parseAuthBody(body);
              if (json) {
                captureAuth(json, '网络拦截');
                if (json.notificationUrl && !verifiedPromptShown) {
                  verifiedPromptShown = true;
                  job = { state: 'waiting', message: '小米要求安全验证，请在弹出的窗口里按提示完成（可能要短信验证码）…', cameras: null };
                }
              }
            }
          } catch {}
          await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, ev.sessionId).catch(() => {});
          return;
        }

        if (ev.method === 'Network.requestWillBeSent') {
          const { request, type } = ev.params || {};
          if (request?.method === 'POST' && /account\.xiaomi\.com/.test(request.url)) {
            log('检测到登录请求：' + request.url.split('?')[0].slice(-60));
          }
          return;
        }

        if (ev.method === 'Network.responseReceived') {
          const { requestId, response } = ev.params || {};
          if (response && /account\.xiaomi\.com|serviceLoginAuth2/.test(response.url)) {
            candidates.add(requestId);
          }
          return;
        }

        if (ev.method === 'Network.loadingFinished') {
          const { requestId } = ev.params || {};
          if (!candidates.has(requestId)) return;
          candidates.delete(requestId);
          let body = '';
          for (let i = 0; i < 3 && !body; i++) {
            try {
              const r = await cdp.send('Network.getResponseBody', { requestId }, ev.sessionId);
              body = r.body || '';
              if (r.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
            } catch (e) {
              await sleep(400);
            }
          }
          if (!body) { log('读取响应失败（' + requestId + '）'); return; }
          const json = parseAuthBody(body);
          if (!json) return;
          captureAuth(json, '响应体');
          if (!authState.auth && json.notificationUrl) {
            log('小米要求异地验证');
            if (!verifiedPromptShown) {
              verifiedPromptShown = true;
              job = { state: 'waiting', message: '小米要求安全验证，请在弹出的窗口里按提示完成（可能要短信验证码）…', cameras: null };
            }
          }
          return;
        }
      } catch {}
    });

    await cdp.send('Page.navigate', { url: LOGIN_URL }, sessionId);
    log('登录页已打开');

    const deadline = Date.now() + TIMEOUT_MS;
    let lastCookieLog = 0;
    while (Date.now() < deadline) {
      if (cdp.closed) throw new Error('登录窗口被关掉了，请重新点一次登录');
      if (windowGone && Date.now() - goneAt > 60000) {
        throw new Error('登录窗口被关掉了，请重新点一次登录');
      }
      let cookies = [];
      try {
        cookies = (await cdp.send('Storage.getCookies')).cookies || [];
      } catch {
        if (cdp.closed) throw new Error('登录窗口被关掉了，请重新点一次登录');
      }
      const token = cookies.find((c) => c.name === 'serviceToken');
      if (token) {
        if (!tokenAt) tokenAt = Date.now();
      } else {
        tokenAt = 0;
      }
      if (!authState.auth) {
        const hv = await cdp
          .send('Runtime.evaluate', { expression: 'JSON.stringify(window.__miAuth||[])', returnByValue: true }, sessionId)
          .catch(() => null);
        if (hv?.result?.value) {
          try {
            for (const item of JSON.parse(hv.result.value)) {
              const j = parseAuthBody(item.t || '');
              if (j && j.ssecurity) captureAuth(j, '页面脚本');
              if (j && j.notificationUrl && !verifiedPromptShown) {
                verifiedPromptShown = true;
                job = { state: 'waiting', message: '小米要求安全验证，请在弹出的窗口里按提示完成（可能要短信验证码）…', cameras: null };
              }
            }
          } catch {}
        }
      }
      if (!authState.auth && token && !qrWarned && Date.now() - tokenAt > 15000) {
        qrWarned = true;
        job = {
          state: 'waiting',
          message: '登录已完成，但还没拿到米家接口密钥。如果你刚才是扫码登录，请关掉登录窗口，重新点按钮，改用【账号密码】登录。',
          cameras: null,
        };
        log('serviceToken 已出现但缺少 ssecurity，提示改用密码登录');
      }
      const auth = authState.auth;
      if (Date.now() - lastCookieLog > 8000) {
        lastCookieLog = Date.now();
        log('轮询：ssecurity=' + (auth ? '有' : '无') + ' serviceToken=' + (token ? '有' : '无'));
      }
      if (auth && auth.location && !token && !nodeToken && !redeemTried && Date.now() - authState.authAt > 10000) {
        redeemTried = true;
        try {
          const lr = await fetch(auth.location, { redirect: 'manual' });
          const sc = lr.headers.getSetCookie ? lr.headers.getSetCookie() : [];
          const line = sc.find((x) => /serviceToken=/.test(x));
          if (line) { nodeToken = line.split(';')[0].replace('serviceToken=', ''); log('服务端换取 serviceToken 成功'); }
        } catch {}
      }
      const tokenValue = (token && token.value) || nodeToken;
      if (auth && tokenValue) {
        job = { state: 'waiting', message: '登录成功，正在读取设备列表…', cameras: null };
        const account = buildAccount(auth, cookies, tokenValue);
        const cameras = await onAccount(account);
        job = { state: 'ok', message: '登录成功', cameras };
        log('登录流程完成');
        return;
      }
      await sleep(1500);
    }
    throw new Error('等了 10 分钟还没检测到登录成功，请重新点一次登录');
  } finally {
    try { if (targetId && cdp) await cdp.send('Target.closeTarget', { targetId }); } catch {}
    try { proc.kill(); } catch {}
  }
}
