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

// 米家 miss 协议的 videoquality 档位，实测于两台机器（抓帧量分辨率）：
//   hlmax（CW500 双摄）0 档 2560×1440 / 1 档 640×360 / 2 档只有 640×360 / 3 档 2560×1440
//   hlc7（标准版 2K）  0 档 2304×1296 / 1 档 640×360 / 2、3 档 2304×1296
// 所以 2.5K 必须落在 3 档，而 0 档（摄像头自适应）在两台上都给到机身上限，可以直接当「自动」。
const MAX_QUALITY = { 'isa.camera.hlmax': '3', 'isa.camera.hlc7': '2' };
export const QUALITY_KINDS = ['auto', 'sd', 'max'];

export function maxQualityOf(model) {
  return MAX_QUALITY[model] || '2';
}

// UI 三档 → 协议档位。
// 建流走 buildSubtype：只区分标清和「机型上限」，实测这两个档位的建链最稳。
// 运行中切换走 qualityLevel：auto 才真正交给摄像头自适应（0 档）。
function buildSubtype(model, quality) {
  if (quality === 'sd') return '1';
  return maxQualityOf(model);
}

function qualityLevel(model, quality) {
  if (quality === 'sd') return '1';
  if (quality === 'auto') return '0';
  return maxQualityOf(model);
}
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

// 关掉播放器不会释放小米 P2P 会话，旧流会一直占着摄像头，几次拖动后新连接就起不来
async function deleteStreams(names) {
  await Promise.all(names.map(async (name) => {
    try {
      await request('/api/streams?src=' + encodeURIComponent(name), { method: 'DELETE' }, 5000);
    } catch {}
  }));
}

async function streamNames() {
  try {
    const r = await request('/api/streams', {}, 5000);
    if (!r.ok) return [];
    return Object.keys(JSON.parse(r.body.toString()));
  } catch {
    return [];
  }
}

async function stopReplayStreams(did) {
  const prefix = 'cam' + did + 'r';
  await deleteStreams((await streamNames()).filter((name) => name.startsWith(prefix)));
}

// 回放和直播共用摄像头会话，直播两路不腾出来，窗口接续时新旧会话叠加会被拒绝
async function stopLiveStreams(did) {
  const names = ['cam' + did, 'cam' + did + 'h', 'cam' + did + 'c2', 'cam' + did + 'c2h'];
  await deleteStreams(names);
}

export async function stopPlayback(did) {
  await stopReplayStreams(did);
}

export async function openCamera({ userId, region, did, model, localip, channel = '0', replay, quality = 'max' }) {
  if (!['0', '2'].includes(channel) || (channel === '2' && model !== 'isa.camera.hlmax')) {
    throw new Error('这台摄像头没有所选镜头');
  }
  await stopReplayStreams(did);
  if (replay) await stopLiveStreams(did);
  const name = 'cam' + did + (channel === '0' ? '' : 'c2') + (replay ? `r${replay.start}o${replay.offset}` : '');
  const query = new URLSearchParams({ did, model, channel });
  // 建流就按用户选的档位要画面：hlmax 的默认档只有 640×360，2.5K 必须显式要 3 档；
  // 镜头 2 的运行中切换上游只发主通道参数，只能靠建流时定下来。
  if (!replay) query.set('subtype', buildSubtype(model, quality));
  if (replay) {
    query.set('replay', String(replay.start));
    query.set('offset', String(replay.offset));
    query.set('duration', String(replay.duration));
  }
  const raw = `xiaomi://${userId}:${region}@${localip || '127.0.0.1'}?${query}`;
  await putStream(name, raw);
  await putStream(name + 'h', `ffmpeg:${RTSP}/${name}#video=h264#audio=opus#timeout=30`);

  // Let the player open the session: a separate snapshot would reconnect both lenses twice.
  return {
    name,
    ws: `${API}/api/ws?src=${encodeURIComponent(name + 'h')}`,
  };
}

export async function moveCamera(did, direction) {
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new Error('无效的云台方向');
  }
  const query = new URLSearchParams({ src: 'cam' + did, motor: direction, via: 'p2p' });
  let r;
  try {
    r = await request('/api/xiaomi/ctl?' + query, { method: 'POST' }, 8000);
  } catch {
    throw new Error('云台请求超时，请确认镜头 1 仍在播放后再试');
  }
  if (r.status === 409) throw new Error('云台连接已断开，请先重连镜头 1');
  if (!r.ok || r.body.toString().trim() !== 'ok') {
    throw new Error('云台指令未能发送，请确认镜头 1 已连接后重试');
  }
}

// 运行中切画质：走 go2rtc 的 ctl，会话不断开，新档位从摄像头的下一个关键帧生效。
export async function setQuality(did, model, quality, channel = '0') {
  const src = 'cam' + did + (channel === '0' ? '' : 'c2');
  const query = new URLSearchParams({ src, quality: qualityLevel(model, quality) });
  let r;
  try {
    r = await request('/api/xiaomi/ctl?' + query, { method: 'POST' }, 10000);
  } catch {
    throw new Error('切换画质超时，请确认画面仍在播放后再试');
  }
  if (r.status === 409) throw new Error('这个镜头还没连上，无法切换画质');
  if (!r.ok || r.body.toString().trim() !== 'ok') {
    throw new Error('摄像头没有接受画质切换，请保持画面播放后再试');
  }
}

export async function listRecordings(did) {
  const query = new URLSearchParams({ src: 'cam' + did });
  let r;
  try {
    r = await request('/api/xiaomi/recordings?' + query, {}, 35000);
  } catch {
    throw new Error('读取存储卡录像超时，请重连实时画面后重试');
  }
  if (r.status === 409) throw new Error('请先连接实时画面（双摄设备请连接镜头 1）');
  if (!r.ok) throw new Error('读取存储卡失败，请重连画面后重试：' + r.body.toString().trim());
  const items = JSON.parse(r.body.toString());
  if (!Array.isArray(items) || items.some((item) => !Number.isSafeInteger(item.start) || item.start <= 0 || !Number.isInteger(item.duration) || item.duration <= 0 || item.duration > 255)) {
    throw new Error('摄像头返回的录像列表格式不正确');
  }
  return items;
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
