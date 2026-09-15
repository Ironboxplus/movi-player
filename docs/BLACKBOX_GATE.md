# 黑盒门禁契约

`scripts/real-openlist-playback.mjs` 是这个播放器的上线门禁：每次改动之后跑一遍真实媒体的解码/渲染/字幕，绿了才谈上生产。

这份文档存在的理由：**"门禁红了"本身不构成"不能上线"。** 有的失败项衡量的是宿主机器当时的状态，不是代码。在 2026-09-13 之前没有这份契约，于是每一次红灯都要靠人逐条解释哪些该管、哪些不该管——解释权在人手里，门禁就不是门禁。

---

## 怎么跑

```bash
# 1. 页面（必须显式 --host 127.0.0.1；只写 --port 会绑到 [::1]，harness 连不上）
npx vite --port 4173 --strictPort --host 127.0.0.1

# 2. 凭据与样本矩阵
source /e/Go/Openlist/.secrets/openlist.env

# 3. 浏览器：发布证据必须用系统 Chrome，不能用 Playwright 自带 Chromium（见下）
export MOVI_CHROME_EXECUTABLE="C:\Program Files\Google\Chrome\Application\chrome.exe"

# 4. 跑
node scripts/real-openlist-playback.mjs
```

### 用哪个浏览器决定了硬件解码的结论

不设 `MOVI_CHROME_EXECUTABLE` 时，Playwright 用它自带的 Chromium。**那个二进制没有硬件解码，也没有
HEVC。** 2026-09-15 同机同时实测（能力查询，不取媒体）：

| | 系统 Chrome 152 | Playwright 自带 Chromium 145 |
|---|---|---|
| HEVC Main / Main10 | `true`，`powerEfficient: true` | **`false`（完全不支持）** |
| H.264 | `true`，`powerEfficient: true` | `true`，`powerEfficient: **false**` |
| VP9 / AV1 | `true`，`powerEfficient: true` | `true`，`powerEfficient: **false**` |

后果：在自带 Chromium 上，HEVC 样本会掉到 `Software (FFmpeg Worker)` 并报
`softwareDecodeReason: "hardware-refused"`——**那是正确行为，不是缺陷**；而 `hardware-preferred` 与
`no-preference` 之间的反复翻转，也是在一个没有硬件后端的二进制上测"是否协商到硬件"的必然结果。

**任何关于硬件解码的结论，必须先确认报告里的浏览器版本。** harness 每次运行都会记录 Chrome 版本与 GPU
renderer 字符串，就是为了这个。

结果 JSON 落在 `MOVI_BLACKBOX_OUTPUT`（默认 `.blackbox-results/real-openlist.json`），失败截图落在
`.blackbox-results/screenshots/`。

**读结果先看 `passed` / `failed` 两个总数。** 单项证据（字节预算、PGS 像素数、音频 RMS）通过不等于门禁通过；
只报单项而不报总数，读的人会以为可以上线。

---

## 判定分级

### 一级：硬门禁（红了就是不能上线）

| 步骤 | 断言的是什么 |
|---|---|
| `steady playback` | 时钟推进接近 1x；画面在窗口内**曾经**出现过内容；有音轨时音频 RMS 高于静音底 |
| `head seek` / `tail seek` / `middle seek` / `near-keyframe seek` | seek 后能恢复到接近 1x，且不残留 HTTP buffer waiters |
| `consecutive seeks` | 连续 5 次不等待的 seek 之后仍能恢复（demuxer FIFO 操作链 / 重启屏障 / worker generation 门控的压力测试） |
| `pause/resume` | 暂停恢复后时钟不跳变 |
| `audio track switch` | 切轨后媒体时钟仍接近 1x |
| `quality/ABR` | 切档后画面继续推进 |
| `background/foreground` | 标签页切后台再回来，时钟不跑飞 |
| `subtitles` | 字幕轨可选、可渲染；PGS 位图有不透明像素 |
| `final state check` | 收尾时不残留 HTTP buffer waiters |
| `byte budget` | 实际流量不超过按码率+预取窗口算出的预算 |
| `hardware-preferred config check` 的**第一条** | H.264 **没有掉到软解/WASM**（`videoDecoder` 匹配 `/software|wasm/`）。这条**没有逃生舱**，任何情况下红了都是真缺陷 |

### 二级：环境量（红了不阻塞上线，但必须在报告里写明）

| 步骤 | 为什么是环境量 |
|---|---|
| `hardware-preferred config check` 的**第二条** | 用的是 WebCodecs，但 `videoDecoder` 字符串不含 `hardware-preferred` |

这条衡量的是**宿主机器这一刻能不能协商出硬件解码会话**，不是代码质量。降级发生在
`src/decode/VideoDecoder.ts:314-332`：`isConfigSupported({hardwareAcceleration:"prefer-hardware", ...})`
返回 unsupported、而去掉该字段后 supported 时，代码 `delete config.hardwareAcceleration` 并继续走
**硬件 WebCodecs**，只是不再带 "prefer" 提示。

实测依据（2026-09-13，同一台机器同一天）：12:16 的 sweep 全部 `no-preference`，14:02 的 sweep 全部
`hardware-preferred`，中间没有任何相关代码改动。**不要拿这个字符串和某个 commit 做时间相关性推因果。**

> `hardwareAcceleration: "prefer-hardware"` 是**请求**，不是保证。浏览器可以接受这个配置字符串却仍然在
> CPU 上解码。想知道是否真的走了硬件路径，看
> `navigator.mediaCapabilities.decodingInfo()` 的 `powerEfficient`——harness 把它作为**观测值**记录，不作断言。

### `MOVI_BLACKBOX_ALLOW_NO_PREFERENCE`

设为 `1` 时二级那条降级为 stderr 警告，结果 JSON 的 `acceptanceMode` 变成 `diagnostic-no-preference`。

**发布证据一律不得设置这个变量。** 它只用于宿主确实拿不到硬件 WebCodecs 会话时，让门禁能跑完剩下的步骤、
把真缺陷暴露出来——不是用来把红灯洗绿的。审阅任何一份黑盒报告，先确认
`acceptanceMode === "strict-hardware"`。

---

## 上线判定

```
可以上线  ⟺  acceptanceMode === "strict-hardware"
          且  所有一级步骤在所有样本上通过
          （二级步骤的失败必须在报告里逐条列出并注明是环境量）
```

`passed === samples` 是充分条件，但不是必要条件：4/7 样本只挂在二级项上时，它们实质上是通过的。
**这个豁免只对二级项成立，不得扩展到任何一级项。**

---

## 已知会骗人的地方（踩过，别再踩）

### 失败截图 vs 被判定的那一帧

`assertRealPicture()` 逐个样本就地判定、就地截图，失败消息里带 `currentTime`。
**这是 2026-09-13 修的**（`db2b937`）：此前三次采样先全部采完、之后才统一判定，截图因此比失败的那一帧
晚 ≥3 秒。在片头淡入的样本上，一个 2.3s 的正确读数会被一张 5.3s 的彩色厂标截图"推翻"。

**有直接证据先看直接证据。** 截图一直躺在 `.blackbox-results/screenshots/`，而三轮调查都绕过它靠推理，
得出三个互相矛盾的结论。

### 单个平坦样本不是解码失败

淡入淡出、转场、黑底字卡都是合法内容，luma 直方图分不出"内容是黑的"和"解码坏了"。
判据是**整个窗口从未出现过画面**才失败。绿屏例外——那从来不是合法内容，立即失败。

### 不要从活画布读像素

`capturePicture()` 走 `page.screenshot()` 裁 canvas 矩形 → 页面内 `<img>` 解码 → 统计。
**不要改回 `drawImage(liveCanvas)` + `getImageData()`**：A/B 实测（`.secrets/pixel-readback-ab-repro.mjs`）
同帧同瞬间两条路径 luma spread 最大差 ~75 点，headless 15 次中 5 次、headful 15 次中 3 次越过判异阈值——
**两种模式都会发散，不是 headless 专属**。根因是活画布在被读的同时还在被渲染循环重写，没有"这一帧画完了"的信号。

字幕路径不受此影响：从 `SubtitleDecoder.ts:107-113` 的 `await createImageBitmap()` 起就是不可变快照，
之后每个中间 canvas 都是"创建→画一次→编码→丢弃"，同一个同步调用栈内没有第二个写者。

### 流量由 seek 次数 × 预取窗口决定

不是播放时长。`buffersize` 是唯一杠杆，字幕探测最多 16 次 seek。跑全量前先想清楚要花多少流量。

---

## 样本矩阵

七个样本，编码组合从真实容器字节确认过（非猜测），覆盖
DTS / DTS-HD MA / TrueHD / AC3 / FLAC / AAC 音频，H.264 / HEVC Main10 / MPEG-2 视频，PGS / 文本字幕。
路径与逐样本编码说明在 `.secrets/openlist.env`（仓外）。
