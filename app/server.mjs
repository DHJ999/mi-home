import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MiIOT, getMiIOT } from 'mi-service-lite';
import { beginBrowserLogin, browserLoginState, browserLoginHookToken, ingestHookPayload } from './browser-login.mjs';
import { ensureRunning, openCamera, stop as stopGo2rtc } from './go2rtc.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);

const PORT = 1990;
const PUB = path.join(ROOT, 'public');
const SESSION = path.join(ROOT, 'session.json');
// 小米云端分区：国内账号 cn，海外账号可环境变量覆盖
const REGION = process.env.MI_REGION || 'cn';

let account = null;
let miot = null;
let cameras = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function slimAccount(a) {
  return {
    sid: a.sid,
    deviceId: a.deviceId,
    userId: a.userId,
    serviceToken: a.serviceToken,
    pass: {
      ssecurity: a.pass?.ssecurity,
      cUserId: a.pass?.cUserId,
      passToken: a.pass?.passToken,
      nonce: a.pass?.nonce,
    },
  };
}

async function loadSession() {
  try {
    const j = JSON.parse(await fs.readFile(SESSION, 'utf8'));
    if (j?.account?.serviceToken && j?.account?.pass?.ssecurity) {
      account = j.account;
      miot = new MiIOT(account);
      return true;
    }
  } catch {}
  return false;
}

async function saveSession() {
  await fs.writeFile(SESSION, JSON.stringify({ account }, null, 2), 'utf8');
}

function applyDevices(list) {
  cameras = (list || [])
    .filter((d) => /camera|doorbell|cateye/i.test(d.model || ''))
    .map((d) => ({
      did: d.did,
      name: d.name,
      model: d.model,
      online: !!d.isOnline,
      localip: d.localip,
    }));
  return cameras;
}

async function listCameras() {
  return applyDevices((await miot.getDevices()) || []);
}

async function login(user, pass) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  const capture = (...args) => lines.push(args.map(String).join(' '));
  console.log = capture;
  console.error = capture;
  try {
    const m = await getMiIOT({ userId: user, password: pass, timeout: 30000 });
    if (!m) {
      const urls = lines.join('\n').match(/https?:\/\/[^\s"'<>]+/g) || [];
      const url = urls.find((u) => /xiaomi\.com/.test(u)) || null;
      return { status: url ? 'verify' : 'error', url, message: lines.slice(-4).join('\n') };
    }
    account = slimAccount(m.account);
    miot = new MiIOT(account);
    await saveSession();
    await fs.rm(path.join(ROOT, '.mi.json'), { force: true });
    return { status: 'ok', cameras: await listCameras() };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

let verifyJob = null;

function cancelVerify() {
  if (verifyJob?.timer) clearTimeout(verifyJob.timer);
  verifyJob = null;
}

function armVerify(ms) {
  if (!verifyJob || verifyJob.state !== 'pending') return;
  verifyJob.timer = setTimeout(runVerifyAttempt, ms);
}

async function beginVerify(user, pass) {
  cancelVerify();
  const job = {
    state: 'pending',
    message: '等待你在小米页面完成验证，程序会自动检测…',
    tries: 0,
    user,
    pass,
    startedAt: Date.now(),
    timer: null,
  };
  verifyJob = job;
  try {
    const deviceId = 'android_' + randomUUID();
    await fs.writeFile(path.join(ROOT, '.mi.json'), JSON.stringify({ miiot: { deviceId } }), 'utf8');
  } catch {}
  armVerify(45_000);
}

async function runVerifyAttempt() {
  const job = verifyJob;
  if (!job || job.state !== 'pending') return;
  job.timer = null;
  if (Date.now() - job.startedAt > 60 * 60 * 1000) {
    job.state = 'timeout';
    job.message = '等了 1 小时小米还没同步授权，请手动再点一次「登录」。';
    job.pass = null;
    return;
  }
  job.tries += 1;
  try {
    const r = await login(job.user, job.pass);
    if (verifyJob !== job) return;
    if (r.status === 'ok') {
      job.state = 'ok';
      job.cameras = r.cameras || [];
      job.message = '登录成功';
      job.pass = null;
      return;
    }
    if (r.status === 'verify') {
      job.message = `小米还没同步授权（已自动重试 ${job.tries} 次），继续等待…`;
      const wait = [90, 150, 240, 300][Math.min(job.tries, 4)];
      armVerify(wait * 1000);
      return;
    }
    job.state = 'error';
    job.message = (r.message || '登录失败，请手动重试').replace(/[✅❌🔥👉🐛]/g, '').trim();
    job.pass = null;
  } catch (e) {
    if (verifyJob !== job) return;
    job.message = '自动重试出错：' + e.message;
    armVerify(120_000);
  }
}

// 画面走小米云端的 cs2 P2P 通道，由本地 go2rtc 负责打洞和转码
async function startStream(did) {
  if (!cameras.length) await listCameras();
  const cam = cameras.find((c) => c.did === did);
  if (!cam) throw new Error('设备不在列表里，请刷新');
  const passToken = account?.pass?.passToken;
  if (!passToken) throw new Error('登录信息里没有云端凭证，请退出后重新登录');
  await ensureRunning(String(account.userId), passToken);
  return openCamera({
    userId: String(account.userId),
    region: REGION,
    did: cam.did,
    model: cam.model,
    localip: cam.localip,
  });
}

async function serveStatic(res, pathname) {
  const file = path.join(PUB, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!file.startsWith(PUB)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (!account) return json(res, 200, { loggedIn: false });
      if (!cameras.length) await listCameras();
      return json(res, 200, { loggedIn: true, cameras, user: account.userId });
    }
    if (req.method === 'POST' && url.pathname === '/api/hook') {
      if (url.searchParams.get('t') && url.searchParams.get('t') === browserLoginHookToken()) {
        try { ingestHookPayload(await readBody(req)); } catch {}
      }
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/browser-login') {
      const st = browserLoginState();
      if (st.state !== 'launching' && st.state !== 'waiting') {
        beginBrowserLogin({
          onAccount: async (acct) => {
            const test = new MiIOT(acct);
            const list = await test.getDevices();
            if (!list) throw new Error('登录成功了，但小米接口没有返回设备列表，请重试');
            account = acct;
            miot = test;
            applyDevices(list);
            await saveSession();
            await fs.rm(path.join(ROOT, '.mi.json'), { force: true });
            return cameras;
          },
        });
      }
      return json(res, 200, browserLoginState());
    }
    if (req.method === 'GET' && url.pathname === '/api/browser-login/status') {
      return json(res, 200, browserLoginState());
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { user, pass } = await readBody(req);
      if (!user || !pass) return json(res, 400, { error: '账号和密码都要填' });
      cancelVerify();
      const r = await login(user, pass);
      if (r.status === 'verify' && r.url) await beginVerify(user, pass);
      return json(res, 200, r);
    }
    if (req.method === 'GET' && url.pathname === '/api/login/status') {
      return json(res, 200, {
        state: verifyJob?.state || 'idle',
        message: verifyJob?.message || '',
        tries: verifyJob?.tries || 0,
        cameras: verifyJob?.state === 'ok' ? verifyJob.cameras : undefined,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      if (!account) return json(res, 401, { error: '未登录' });
      return json(res, 200, { cameras: await listCameras() });
    }
    if (req.method === 'POST' && url.pathname === '/api/stream') {
      if (!account) return json(res, 401, { error: '未登录' });
      const { did } = await readBody(req);
      const r = await startStream(did);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      cancelVerify();
      account = null;
      miot = null;
      cameras = [];
      await stopGo2rtc();
      await fs.rm(SESSION, { force: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const page = `http://127.0.0.1:${PORT}`;
    console.log(`服务已经在运行，直接打开页面：${page}`);
    if (process.env.MI_NO_OPEN !== '1') exec(`start "" ${page}`);
    process.exit(0);
  }
  throw e;
});

loadSession().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    const page = `http://127.0.0.1:${PORT}`;
    console.log(`米家看家已启动：${page}`);
    if (process.env.MI_NO_OPEN !== '1') exec(`start "" ${page}`);
  });
});
