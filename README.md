# 清明上河图 · 卷轴互动版

上下滑动 = 左右展卷：页面的竖向滚动位置就是播放时刻，滚动 1 像素 = 画面横移 1 像素。
停下来画面就停，往回滚画面就倒着走；也可以按「自动展卷」按原速播放。
声音分两层：**背景音乐**（《汴河画卷》两首，顺序循环，与滚动无关）和**环境音**（画心原声，跟着滚动速度响起）。

## 打开

```bash
python3 serve.py            # → http://127.0.0.1:8765/
```

也可以直接双击 `index.html`（file://）：画面、背景音乐都正常；环境音退成 `<audio>` 兜底（固定 1 倍速，偏差大了再对齐）。

| 操作 | 效果 |
|---|---|
| 滚轮 / 触控板上下滑 / 手指上下滑 | 展卷（前进、后退、快慢都跟手） |
| 触控板左右扫 / 抓住画面左右拖 | 同上，松手带惯性 |
| 底部全卷缩略条 | 点哪跳哪，按住拖动快速翻卷；红色菱形是三首题诗 |
| ← → / ↑ ↓（Shift 加大步） | 前后 2 秒（10 秒） |
| PageUp / PageDown、1–7 | 上一段 / 下一段、直接跳段 |
| 空格 | 自动展卷（右上角 1× 按钮切 0.5× / 2×） |
| M / N / F | 背景音乐 开关 / 环境音 开关 / 全屏 |
| `index.html#t=85` | 直接翻到第 85 秒 |

## 背景音乐

- 默认开、进页面就试着播。浏览器不允许没交互就出声（Chrome / Safari 都拦），这时「音乐」按钮会闪，
  点「展卷」或页面任意处、按任意键就开始；滚轮不算浏览器认可的交互。
- 点「音乐」暂停（淡出），再点从原处续播；关掉后会记住，下次打开不自动播。切到别的标签页时自动停，回来续上。
- 曲目在 `config.js` 的 `music`：换曲 / 加曲就改这里，文件放 `media/music/`。`gain`（dB）用来把各首拉到约 −19 LUFS
  ，新曲子可以这样量：`ffmpeg -i 曲子.mp3 -af ebur128 -f null -` 看 Summary 里的 I，`gain = −19 − I`。
- 环境音音量在 `config.js` 的 `ambienceGain`（现在 0.2，即原混音的 20%，约 −14 dB）。
  滚动时音乐会按环境音的响度稍稍让一让（现在约 −0.6 dB）。

## 重新生成素材

成片改了以后，在 `qingmingshanghetu/` 下：

```bash
../.venv/bin/python build_web.py                 # video audio pano images meta 全做（视频约 2 分钟）
../.venv/bin/python build_web.py pano audio      # 只重做其中几项
QM_MAIN=output/xxx.mp4 ../.venv/bin/python build_web.py
```

时间轴和 `make_full.sh` 一样：引首 4s → 画心（主体第 30 帧起）→ 拖尾 10s，共 193s。
段落、天色、题诗的时刻在 `config.js`，按 `qingming_v8.py` 的 CAPTIONS / NIGHT / DAWN / POEMS 换算。

## 发布（GitHub Pages）

线上地址：**https://xiwan.github.io/qingming-scroll/** （仓库 `xiwan/qingming-scroll`，就是这个 `web/` 目录）

改完直接提交、推送，`.github/workflows/pages.yml` 会自动重新发布（约 1–2 分钟），在仓库的 Actions 页能看进度：

```bash
git add -A && git commit -m "说明改了什么" && git push
```

- GitHub 单个文件上限 100 MB，所以 1080p 编成每 2 秒一个关键帧、CRF 27（89 MB），全部文件都走普通 git，
  不用 Git LFS（LFS 的流量额度会被别人 clone 公开仓库吃掉）。`build_web.py` 发现超过 95 MiB 的文件会直接报错。
- 访客看视频走 GitHub Pages 的流量（软上限每月 100 GB；看一遍完整的卷大约下载 70–90 MB）。
- 视频每重做、提交一次，仓库历史里就多存一份（约 160 MB）。GitHub 建议仓库别超过 1 GB，偶尔重做没关系，别天天重编码。

## 部署到别处

整个 `web/` 目录放到任意静态托管即可（nginx、S3/CloudFront、GitHub Pages、Vercel……都支持 Range 请求）。
`media/` 约 180 MB：`qingming_1080.mp4` 89 MB、`qingming_720.mp4` 65 MB（窄屏 / 省流量时自动选，右上角可切）、
背景音乐两首 16 MB、环境音 3 MB、缩略条 0.2 MB。视频是边看边载入的，不用等全部下完。

## 实现要点（改代码前先看）

- **手动滚动时每帧 seek 到滚动位置**。720p 每秒一个关键帧，一次 seek 约 7 ms，Chrome / WebKit 在 0.5×–17×
  的滚动速度下都 ≈ 60 fps、几乎零延迟；1080p 每 2 秒一个关键帧（为了压到 100 MB 以内），一次 seek 约 21 ms，
  快速拖动时 Chrome ≈ 40 fps、WebKit 往前 ≈ 57 fps。都比"调倍速播放去追"出帧多（Chrome 倍速 2× 只出 45 fps、
  5× 只出 32 fps）。滚轮一格跳一大截时分几帧缓过去。自动展卷才用正常播放。
- **声音不能用 `<audio>` 变速**：WebKit 里改媒体元素的 `playbackRate` 会把 `<video>` 的 seek 卡住几百毫秒。
  所以环境音整段解码进 Web Audio（24 kHz 单声道 ≈ 18 MB），用 BufferSource 的 playbackRate 跟滚动速度走。
  背景音乐始终 1 倍速，用普通 `<audio>`（实测每帧改音量不影响 seek）；iOS 上 volume 只读，改走 Web Audio 增益。
- **环境音要按样本对齐**：`adelay` 只挪时间戳，按样本解码的 Web Audio 会整体提前 4 秒；`build_web.py` 用 numpy 直接拼样本。
- 本地预览别用 `python -m http.server`：它不支持 Range，Chrome 里 seek 会跳回开头。
