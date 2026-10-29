import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = 'E:\\Code\\mi-home\\go2rtc';
const EXE = path.join(DIR, 'go2rtc-cs2.exe');
const CFG = path.join(DIR, 'go2rtc-app.yaml');
const LOG = path.join(DIR, 'go2rtc-app.log');
const PID = path.join(DIR, 'go2rtc-app.pid');
const FFMPEG = 'D:/ffmpeg/bin/ffmpeg.exe';

const API = 'http://127.0.0.1:1984';
// 播放器页面在 1990，向 1984 建 WebSocket 时会被 go2rtc 做来源校验
const APP_ORIGIN = 'http://127.0.0.1:1990';
const RTSP = 'rtsp://127.0.0.1:8554';

let proc = null;
let runKey = '';
let logHandle = null;
let starting = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function configYaml(userId, passToken) {
  return [
    'api:',
    '  listen: "127.0.0.1:1984"',
    `  origin: "${APP_ORIGIN}"`,
    'rtsp:',
    '  listen: ":8554"',
    'webrtc:',
    '  listen: ":8555"',
    'log:',
    '  level: info',
    'ffmpeg:',
    `  bin: "${FFMPEG}"`,
    'xiaomi:',
    `  '${userId}': '${passToken}'`,
    '',
  ].join('\n');
}

// 响应体必须读干净：node 的 undici 在连接带着未读数据被关闭时会抛内部断言并让整个程序退出
async function request(pathname, init = {}, timeout = 10000) {
  const r = await fetch(API + pathname, {
    ...init,
    signal: AbortSignal.timeout(timeout),
    cache: 'no-store',
  });
  return { ok: r.ok, status: r.status, body: Buffer.from(await r.arrayBuffer()) };
}

async function waitReady(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await apiUp()) return true;
    await sleep(300);
  }
  return false;
}

async function tailError() {
  try {
    const text = await fs.readFile(LOG, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => /cs2 cloud|tutk|ERROR|error/i.test(l));
    return lines.slice(-3).join(' / ');
  } catch {
    return '';
  }
}

async function apiUp() {
  try {
    return (await request('/api/streams', {}, 2000)).ok;
  } catch {
    return false;
  }
}

// 上一次异常退出可能留下还占着 1984 端口的孤儿进程，先按 pid 文件收回端口
async function freePort() {
  if (!(await apiUp())) return;
  let pid = 0;
  try {
    pid = Number(await fs.readFile(PID, 'utf8'));
  } catch {}
  if (!pid) throw new Error('1984 端口被其它程序占用，请关闭其它 go2rtc 后重试');
  try {
    process.kill(pid);
  } catch {}
  const end = Date.now() + 5000;
  while (Date.now() < end && (await apiUp())) await sleep(200);
  await fs.rm(PID, { force: true });
}

export async function ensureRunning(userId, passToken) {
  if (!userId || !passToken) throw new Error('还没有拿到小米登录凭证，请重新登录');
  const key = userId + '|' + passToken;
  if (proc && runKey === key && proc.exitCode === null) return;
  if (starting) await starting.catch(() => {});
  if (proc && runKey === key && proc.exitCode === null) return;

  starting = (async () => {
    await stop();
    await freePort();
    await fs.writeFile(CFG, configYaml(userId, passToken), { mode: 0o600 });
    logHandle = await fs.open(LOG, 'a');
    proc = spawn(EXE, ['-config', CFG], {
      cwd: DIR,
      windowsHide: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: { ...process.env, MI_NO_OPEN: '1' },
    });
    await fs.writeFile(PID, String(proc.pid), 'utf8');
    proc.on('exit', () => {
      proc = null;
      runKey = '';
      logHandle?.close().catch(() => {});
      logHandle = null;
    });
    if (!(await waitReady(15000))) {
      await stop();
      throw new Error('本地流媒体服务没能启动，请查看 go2rtc-app.log');
    }
    runKey = key;
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
}

async function putStream(name, src) {
  const q = `name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`;
  const r = await request('/api/streams?' + q, { method: 'PUT' });
  if (!r.ok) throw new Error('添加摄像头失败（' + r.status + '）：' + r.body.toString().trim());
}

/**
 * Open one camera through Xiaomi's cloud relay and return the player url.
 * The raw stream keeps the camera's own codec; the "h" copy is transcoded to
 * H.264/Opus so any browser can show it.
 */
export async function openCamera({ userId, region, did, model, localip }) {
  const name = 'cam' + did;
  const raw = `xiaomi://${userId}:${region}@${localip || '127.0.0.1'}?did=${did}&model=${model}`;
  await putStream(name, raw);
  await putStream(name + 'h', `ffmpeg:${RTSP}/${name}#video=h264#audio=opus`);

  // Asking for one snapshot starts the producer and proves the P2P session;
  // the first cloud connect can take a few seconds while the camera wakes up.
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    try {
      const r = await request('/api/frame.jpeg?src=' + encodeURIComponent(name), {}, 45000);
      ok = r.ok && r.body.length > 1000;
      if (!ok) await sleep(1500);
    } catch {
      await sleep(1500);
    }
  }
  if (!ok) {
    const detail = await tailError();
    throw new Error('没能连上这台摄像头的云端通道' + (detail ? '：' + detail : '，请稍后重试'));
  }

  return {
    name,
    ws: `${API}/api/ws?src=${encodeURIComponent(name + 'h')}`,
  };
}

export async function stop() {
  if (!proc) return;
  const p = proc;
  proc = null;
  runKey = '';
  try {
    p.kill();
  } catch {}
  await new Promise((r) => {
    p.once('exit', r);
    setTimeout(r, 3000);
  });
  await fs.rm(PID, { force: true });
  logHandle?.close().catch(() => {});
  logHandle = null;
}

process.on('exit', () => {
  try {
    proc?.kill();
  } catch {}
});
