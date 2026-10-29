<div align="center">

# 米家看家

**在自己电脑上登录小米账号，远程观看家里米家摄像头的实时画面**
不要求与摄像头在同一局域网 · 画面只经过这台电脑

[![平台][b-platform]][repo]
[![Node][b-node]][repo]
[![运行包][b-release]][releases]
[![最近提交][b-commit]][commits]
[![许可][b-license]](#许可与免责)

</div>

---

## 这是什么

米家官方没有 PC 端的实时观看入口，只有手机 App。这个项目在你自己电脑上跑一个小服务，把画面搬到浏览器里：

- **登录**：调起本机 Edge 打开小米官方登录页，账号密码、短信、异地验证全部在小米自己的页面完成，密码不经过本程序
- **取流**：拿到云端凭证后，通过小米云的加密 P2P 通道把画面取回本机，不依赖局域网、不需要公网 IP、不用端口映射
- **播放**：ffmpeg 把摄像头原始编码转成 H.264/Opus，浏览器用 WebRTC 低延迟播放，有声音、可全屏

人在外面、公司、老家，只要能上网就能看，通常比官方 App 晚几秒。

## 实测机型

| 设备 | 内部型号 | 画面 | 结果 |
|---|---|---|---|
| 小米智能摄像机 标准版 2K | `isa.camera.hlc7` | 2304×1296 | 正常，含声音 |
| 小米室外摄像机 CW500 双摄版 | `isa.camera.hlmax` | 640×360（第一路） | 正常，含声音 |

## 工作原理

```text
浏览器 :1990 ──① 站内登录──▶ Node 服务
                               │ ② 账号 / 设备列表 / 云端凭证（miot API）
                               ▼
                          小米云
                               │ ③ 凭证写入本机配置
                               ▼
go2rtc-cs2.exe :1984 ──④ 打洞(UDP)──▶ 云端 P2P 中继 ──▶ 家里的摄像头
      │ ⑤ 转码为 H.264 / Opus
      ▼
浏览器 <video-rtc> ◀──⑥ WebRTC / MSE（ws://127.0.0.1:1984）
```

- ① 登录在**小米官方页面**完成，本程序只接收结果，不接触密码
- ④ 取流走小米自己的加密通道，与米家 App 是同一套链路
- ⑥ 浏览器与流媒体服务都在本机回环地址，画面不出这台电脑

## 功能

| | |
|---|---|
| 跨网络观看 | 不要求与摄像头同局域网，也不需要公网 IP / DDNS / 端口映射 |
| 官方页面登录 | 密码、短信、异地验证都在 `account.xiaomi.com`，不再反复要求重新登录 |
| 低延迟播放 | WebRTC 传输，几秒延迟，支持声音与全屏 |
| 断线自愈 | 播放中断自动重连；流媒体服务异常退出后点「重新连接」即可拉回 |
| 多设备 | 卡片式设备列表，换摄像头只换流，不用重启程序 |
| 凭证本地 | 登录态与会话只存在本机，退出登录立即删除 |

## 快速开始

### 1. 准备环境

| 依赖 | 要求 |
|---|---|
| 系统 | Windows 10 / 11，需已安装 Microsoft Edge |
| Node.js | 18 或更高 |
| ffmpeg | 默认读取 `D:\ffmpeg\bin\ffmpeg.exe`，路径不同就改 `app/go2rtc.mjs` 顶部 |

### 2. 下载运行包

摄像头取流靠一个独立程序，不放在仓库里，请到 [Releases][releases] 下载 `go2rtc-cs2.exe`，放进仓库根的 `go2rtc/` 目录。

### 3. 启动

```bash
cd app
npm install
```

然后双击 `app/启动.cmd`，或执行 `node server.mjs`，浏览器会自动打开 <http://127.0.0.1:1990>。

## 使用

### 启动

双击 `app/启动.cmd` 会打开一个黑色窗口，**它就是程序本体，看视频时不要关**，最小化即可。重复双击不会冲突：程序发现已经在跑，就只帮你把页面打开。

### 登录

点「打开小米官方登录窗口」，弹出的是小米自己的页面（地址栏为 `account.xiaomi.com`）。账号密码、短信、异地验证都在那里完成，密码不经过本程序。登录成功后窗口自动关闭，页面直接进设备列表，不用刷新、不用重输。

登录态存在 `app/session.json`，下次打开直接进列表。换账号或不再用这台电脑，点右上角「退出登录」，保存的凭证会被删除。

### 观看

- 在设备卡片上点「观看」。首次建立通道约 5～20 秒（要等摄像头被唤醒并完成打洞），之后是连续画面
- 右上角状态：`直播中` 正常；`失败` 时点「重新连接」
- 默认静音播放（浏览器策略），**点一下画面即可取消静音**；画面下方有全屏按钮
- 在米家里新增或改名摄像头后，点「刷新设备」同步列表

排错看两处日志：黑色窗口的输出，以及 `go2rtc/go2rtc-app.log`。

## 本机端口

| 端口 | 用途 |
|---|---|
| 1990 | 网页界面与接口 |
| 1984 | 流媒体服务 API（仅监听 127.0.0.1，并做来源白名单校验） |
| 8554 / 8555 | 本机 RTSP / WebRTC 转发 |

## 文件与凭证

```
app/        网页与 Node 服务（server.mjs、go2rtc.mjs、browser-login.mjs、public/）
go2rtc/     运行包与运行时产物：go2rtc-cs2.exe、配置、日志
```

| 文件 | 说明 |
|---|---|
| `app/session.json` | 小米登录态，**已 gitignore** |
| `go2rtc/go2rtc-app.yaml` | 流媒体账号凭证，**已 gitignore**，程序每次启动自动生成 |
| `go2rtc/go2rtc-app.log` | 取流日志，排障用 |

这两个凭证文件拿到就等于拿到你的小米账号，**不要发给任何人，也不要提交进任何仓库**。退出登录会删除 `session.json` 并停掉流媒体服务。

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面打不开 | 确认黑色窗口还在运行，地址是 `127.0.0.1:1990` |
| 一直停在「连接云端通道…」后失败 | 先在米家 App 确认摄像头在线，再点「重新连接」；首次建链要等摄像头唤醒 |
| 没声音 | 浏览器默认静音播放，点一下画面即可 |
| 提示端口被占用 | 任务管理器里结束残留的 `go2rtc-cs2.exe` 后重新启动 |
| 提示没有运行包 | 按「快速开始 · 2」从 Releases 下载后放进 `go2rtc/` |
| 反复要求重新登录 | 小米改过密码会让旧凭证失效，退出登录后重新登录一次即可 |

## 已知边界

- **仅 Windows**：登录依赖本机 Edge，启动脚本是 `.cmd`
- **双摄机型只接第一路镜头**，第二路尚未接入
- 首次建链约 5～20 秒，取决于摄像头唤醒速度
- 海外账号需设置环境变量 `MI_REGION`（默认 `cn`）指向对应分区
- 小米修改登录或接口策略时需要跟着更新，不保证长期可用

## 许可与免责

本仓库的应用层代码保留权利，未附开源许可；运行包内含 MIT 许可的 [go2rtc](https://github.com/AlexxIT/go2rtc) 代码，许可全文见 [LICENSE-go2rtc.txt](LICENSE-go2rtc.txt)。

本项目仅供**个人在自己的账号和自己的设备上**使用，与小米公司无任何关联，也未获其授权。请自行评估账号风险，因使用本项目产生的任何后果由使用者自行承担。

## 致谢

- [AlexxIT/go2rtc](https://github.com/AlexxIT/go2rtc) — 流媒体服务的基础，MIT
- [mi-service-lite](https://www.npmjs.com/package/mi-service-lite) — 小米云接口调用
- [FFmpeg](https://ffmpeg.org) — 编码转换

[repo]: https://github.com/DHJ999/mi-home
[releases]: ../../releases/latest
[commits]: ../../commits/main
[b-platform]: https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%2010%20%2F%2011-0078D6?logo=windows&logoColor=white
[b-node]: https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white
[b-release]: https://img.shields.io/github/v/release/DHJ999/mi-home?label=%E8%BF%90%E8%A1%8C%E5%8C%85
[b-commit]: https://img.shields.io/github/last-commit/DHJ999/mi-home?label=%E6%9C%80%E8%BF%91%E6%8F%90%E4%BA%A4
[b-license]: https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-%E4%BB%85%E4%BE%9B%E4%B8%AA%E4%BA%BA%E4%BD%BF%E7%94%A8-6e7781
