/* 清明上河图 · 卷轴互动版
 *
 * 上下滑动（滚轮 / 触控板 / 手指）= 左右展卷：页面的竖向滚动位置就是播放时刻，
 * 滚动 1 像素 = 画面横移 1 像素（镜头 120 px/s × 显示缩放）。
 * 画面怎么追上滚动：手动滚动时每帧 seek 到滚动位置——720p 每秒、1080p 每 2 秒一个关键帧（见 build_web.py），
 * 硬件解码下一次 seek 一二十毫秒，实测比倍速播放出帧多、延迟小；自动展卷时才按倍速正常播放。
 */
(() => {
  'use strict';
  const M = window.QM_MEDIA, C = window.QM_CONFIG;
  if (!M || !C) {
    document.getElementById('load').textContent = '缺少 media/meta.js：先运行 build_web.py';
    return;
  }
  const $ = (s) => document.querySelector(s);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const DUR = M.duration, END = DUR - 0.05;
  const [T_MAIN0, T_MAIN1] = M.segments.main;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const video = $('#video'), audio = $('#audio'), freeze = $('#freeze');
  const track = $('#track'), scroll = $('#scroll'), paper = $('#paper');
  const rodL = $('#rod-l'), rodR = $('#rod-r');
  const bar = $('#bar'), pano = $('#pano'), win = $('#win'), tip = $('#tip'), buf = $('#buf');
  const labels = $('#labels'), marks = $('#marks');
  const btnAuto = $('#btn-auto'), btnRate = $('#btn-rate'), btnSound = $('#btn-sound');
  const btnQ = $('#btn-q'), btnFs = $('#btn-fs');

  let progY = -1;                              // 自动展卷 / 重新布局时我们自己设的滚动位置
  const S = {
    target: 0,          // 滚动位置对应的时刻（秒）
    vel: 0,             // 目标时刻的变化速度（秒/秒，平滑过）
    pxPerSec: 100,      // 滚动多少像素 = 一秒
    scale: 1,           // 画面显示宽 / 1920
    visW: M.width,      // 纸面露出的宽度（原片像素；竖屏时两边裁掉）
    playMax: 0,         // 手动滚动速度低于这个倍数时也用倍速播放追（0 = 手动一律每帧 seek，实测 Chrome 最顺）
    auto: false, autoRate: 1, autoUntil: END,
    sound: false,
    q: null,
    started: false,
    bar: { w: 0, intro: 0, pano: 0, outro: 0 },
  };

  // ------------------------------------------------------------------ 布局
  function layout() {
    const cs = getComputedStyle(scroll);
    const bw = scroll.clientWidth, bh = scroll.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const rods = 2 * 30;
    let pw, ph, vw;
    if (bh > bw * 0.9) {                       // 竖屏：纸面拉高、左右裁掉，免得画面只剩一条
      ph = Math.min(bh * 0.86, (bw - rods) * 1.3);
      vw = ph * M.width / M.height;
      pw = Math.min(vw, bw - rods);
    } else {
      vw = Math.min(bw - rods, bh * M.width / M.height);
      ph = vw * M.height / M.width;
      pw = vw;
    }
    pw = Math.floor(pw); ph = Math.floor(ph); vw = Math.floor(vw);
    paper.style.width = pw + 'px';
    paper.style.height = ph + 'px';
    video.style.width = freeze.style.width = vw + 'px';
    video.style.height = freeze.style.height = ph + 'px';
    video.style.left = freeze.style.left = Math.round((pw - vw) / 2) + 'px';
    scroll.style.setProperty('--ph', ph + 'px');
    S.scale = vw / M.width;
    S.visW = pw / S.scale;

    const t = S.target;
    S.pxPerSec = M.panPx * S.scale;
    track.style.height = Math.ceil(DUR * S.pxPerSec + innerHeight) + 'px';
    progY = Math.round(t * S.pxPerSec);
    window.scrollTo(0, progY);

    // 缩略条：引首 | 全卷长条 | 拖尾
    const w = bar.clientWidth;
    const bi = Math.round(clamp(w * 0.035, 26, 50)), bo = Math.round(clamp(w * 0.05, 34, 70));
    S.bar = { w, intro: bi, pano: w - bi - bo, outro: bo };
    bar.style.setProperty('--bi', bi + 'px');
    bar.style.setProperty('--bo', bo + 'px');
    placeMarks();
    render(true);
  }

  // 主体里时刻 t 时，纸面露出的长卷范围（原片像素，0 = 主体第 0 帧左缘）
  const viewAt = (t) => {
    const cx = M.panPx * (clamp(t, T_MAIN0, T_MAIN1) - M.mainOffset) + M.width / 2;
    return [cx - S.visW / 2, cx + S.visW / 2];
  };
  const panoU = (x) => (x - M.pano.x0) / (M.pano.x1 - M.pano.x0);
  const barXofMain = (x) => S.bar.intro + clamp(panoU(x), 0, 1) * S.bar.pano;

  // 缩略条上的视窗 [left, width]（像素）
  function windowAt(t) {
    const B = S.bar;
    const [a, b] = viewAt(t);
    const ml = barXofMain(a), mw = barXofMain(b) - ml;
    if (t < T_MAIN0) {                        // 引首：视窗从"引首"格滑进长条开头
      const k = clamp((t - 1.5) / (T_MAIN0 - 1.5), 0, 1);
      return [lerp(0, ml, k), lerp(B.intro, mw, k)];
    }
    if (t > T_MAIN1) {
      const k = clamp((t - T_MAIN1) / 1.2, 0, 1);
      return [lerp(ml, B.intro + B.pano, k), lerp(mw, B.outro, k)];
    }
    return [ml, mw];
  }

  // 缩略条上的横坐标 → 时刻（点在哪，画面中心就落到哪）
  function timeAtBarX(x) {
    const B = S.bar;
    if (x < B.intro) return clamp(x / B.intro, 0, 1) * (T_MAIN0 - 0.1);
    if (x > B.intro + B.pano) return T_MAIN1 + clamp((x - B.intro - B.pano) / B.outro, 0, 1) * (DUR - T_MAIN1);
    const u = (x - B.intro) / B.pano;
    const cx = M.pano.x0 + u * (M.pano.x1 - M.pano.x0);
    return clamp((cx - M.width / 2) / M.panPx + M.mainOffset, T_MAIN0, T_MAIN1);
  }
  const barXofTime = (t) => barXofMain(viewAt(t)[0] + S.visW / 2);

  // ------------------------------------------------------------------ 段落 / 题诗标记
  const chapterAt = (t) => { let i = 0; C.chapters.forEach((c, k) => { if (t >= c.t) i = k; }); return i; };
  const phaseAt = (t) => { let p = null; C.phases.forEach((c) => { if (t >= c.t) p = c.name; }); return t < T_MAIN0 ? null : p; };

  function buildMarks() {
    C.chapters.forEach((c, i) => {
      const el = document.createElement('button');
      const edge = c.t < T_MAIN0 || c.t >= T_MAIN1;    // 引首 / 拖尾：标在两头的小格上，用短名免得出界
      el.className = edge ? 'label edge' : 'label';
      el.type = 'button';
      el.dataset.i = i;
      el.innerHTML = `<span class="full">${edge ? c.short || c.name : c.name}</span><span class="short">${c.short || c.name}</span>`;
      el.title = `${c.name}（${i + 1}）`;
      el.addEventListener('click', () => jumpTo(c.jump));
      labels.appendChild(el);
    });
    C.poems.forEach((p) => {
      const el = document.createElement('button');
      el.className = 'poem';
      el.type = 'button';
      el.setAttribute('aria-label', p.by);
      el.addEventListener('click', (e) => { e.stopPropagation(); jumpTo(p.at - 3); });
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('pointerenter', () => showTip(barXofTime(p.at), `<b>${p.lines.join('，')}。</b><i>${p.by}</i>`, true));
      el.addEventListener('pointerleave', hideTip);
      p.el = el;
      marks.appendChild(el);
    });
  }

  function placeMarks() {
    [...labels.children].forEach((el) => {
      const c = C.chapters[+el.dataset.i];
      let x;
      if (c.t < T_MAIN0) x = S.bar.intro / 2;
      else if (c.t >= T_MAIN1) x = S.bar.intro + S.bar.pano + S.bar.outro / 2;
      else x = barXofTime(c.at);
      el.style.left = x + 'px';
    });
    C.poems.forEach((p) => { p.el.style.left = barXofTime(p.at) + 'px'; });
  }

  // ------------------------------------------------------------------ 画面追滚动
  function drive() {
    if (video.readyState < 1 || video.seeking) return;
    const V = video.currentTime, d = S.target - V;
    if (S.auto || (S.vel > 0.2 && S.vel < S.playMax)) {      // 自动展卷：按倍速正常播放（音画同步、30fps 节奏）
      if (d > -0.15 && d < 3) {
        if (d < 0.02) {
          if (!video.paused) video.pause();
        } else {
          const r = clamp(Math.max(0, S.vel) + d * 2.5, 0.1, 8);
          if (Math.abs(r - video.playbackRate) > 0.04 * video.playbackRate) video.playbackRate = r;
          if (video.paused) video.play().catch(() => {});
        }
        return;
      }
    }
    if (!video.paused) video.pause();
    if (Math.abs(d) < 0.5 / M.fps) return;                    // 已经停在这一帧上
    // 手动滚动：每帧 seek 到滚动位置（一次十几毫秒，比倍速播放出帧多、不拖后腿）；
    // 滚轮一格跳一大截时分几帧缓过去，跳得很远就直接到
    video.currentTime = Math.abs(d) <= 0.6 || Math.abs(d) >= 3 ? S.target : V + d * 0.45;
  }

  // 声音跟着滚动速度走：往前滚才出声，快了压低音量、调快，停下来淡出。
  // 主路：把配乐整段解码进 Web Audio（24kHz 单声道 ≈ 18MB），BufferSource 的 playbackRate 可以每帧平滑地变。
  // 不用 <audio> 变速：WebKit 里改媒体元素的 playbackRate 会卡住 <video> 的 seek（每改一次停顿几百毫秒）。
  // file:// 下 fetch 不了，退回 <audio> 元素、固定 1 倍速、偏差大了再对齐。
  const A = { ctx: null, buf: null, master: null, src: null, pos: 0, at: 0, rate: 1, loading: false };
  let vol = 0, hold = 0;

  async function loadAudio() {
    if (A.loading || A.buf || !/^https?:$/.test(location.protocol)) return;
    A.loading = true;
    try {
      const data = await (await fetch(M.audio)).arrayBuffer();
      const off = new OfflineAudioContext(1, 1, 24000);
      const dec = await off.decodeAudioData(data);
      const mono = new AudioBuffer({ numberOfChannels: 1, length: dec.length, sampleRate: dec.sampleRate });
      const out = mono.getChannelData(0);
      for (let c = 0; c < dec.numberOfChannels; c++) {
        const ch = dec.getChannelData(c), k = 1 / dec.numberOfChannels;
        for (let i = 0; i < ch.length; i++) out[i] += ch[i] * k;
      }
      A.buf = mono;
      if (!audio.paused) audio.pause();
    } catch (err) {
      A.buf = null;                              // 解码不了就一直用 <audio> 兜底
    }
  }

  function bufPos() {                            // 当前 BufferSource 播到哪了（秒）
    const now = A.ctx.currentTime;
    A.pos += (now - A.at) * A.rate;
    A.at = now;
    return A.pos;
  }
  function bufStart(t, rate) {                   // 从 t 起播一个新的 source，旧的 60ms 淡出
    const now = A.ctx.currentTime;
    if (A.src) bufStop(0.06);
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.06);
    const src = A.ctx.createBufferSource();
    src.buffer = A.buf;
    src.playbackRate.value = rate;
    src.connect(g).connect(A.master);
    src.start(now, clamp(t, 0, A.buf.duration - 0.01));
    A.src = { src, g };
    A.pos = t; A.at = now; A.rate = rate;
  }
  function bufStop(fade) {
    if (!A.src) return;
    const now = A.ctx.currentTime, { src, g } = A.src;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + fade);
    src.stop(now + fade + 0.01);
    A.src = null;
  }

  function driveAudio(dt) {
    const r = S.auto ? video.playbackRate : S.vel;
    const moving = S.sound && r >= 0.4;
    hold = moving ? 0.3 : Math.max(0, hold - dt);
    const want = moving || hold > 0 ? clamp(1.6 / Math.max(r, 1.6), 0.35, 1) : 0;
    vol += (want - vol) * (1 - Math.exp(-dt / (want > vol ? 0.12 : 0.4)));
    const V = video.currentTime;
    if (want === 0 && vol < 0.015) {
      vol = 0;
      if (A.src) bufStop(0.05);
      if (!audio.paused) audio.pause();
      return;
    }
    if (A.buf && A.ctx) {
      A.master.gain.value = vol * C.ambienceGain;
      const ar = clamp(r, 0.5, 3);
      if (!A.src) bufStart(V, ar);
      else if (moving) {
        if (Math.abs(bufPos() - V) > 0.3) bufStart(V, ar);
        else if (Math.abs(A.rate - ar) > 0.01) {
          bufPos();
          A.rate = ar;
          A.src.src.playbackRate.value = ar;
        }
      }
      return;
    }
    audio.volume = clamp(vol * C.ambienceGain, 0, 1);
    if (audio.paused) {
      audio.currentTime = V;
      audio.play().catch(() => {});
    } else if (moving && Math.abs(audio.currentTime - V) > (r > 1.3 ? 0.8 : 0.35)) {
      audio.currentTime = V;
    }
  }

  // ------------------------------------------------------------------ 界面刷新（按画面实际时刻）
  let lastUI = {};
  function render(force) {
    const t = video.readyState >= 1 ? video.currentTime : S.target;
    const [l, w] = windowAt(t);
    const key = `${l.toFixed(1)}|${w.toFixed(1)}`;
    if (force || key !== lastUI.win) {
      win.style.transform = `translateX(${l}px)`;
      win.style.width = w + 'px';
      lastUI.win = key;
    }
    // 卷轴：看过的卷进左轴（越看越粗），右轴是还没展开的
    const p = clamp(t / DUR, 0, 1);
    const dl = Math.round(12 + 12 * p), dr = Math.round(24 - 12 * p);
    if (force || dl !== lastUI.dl || dr !== lastUI.dr) {
      rodL.style.setProperty('--d', dl + 'px');
      rodR.style.setProperty('--d', dr + 'px');
      lastUI.dl = dl; lastUI.dr = dr;
    }
    const ci = chapterAt(t);
    if (force || ci !== lastUI.ci) {
      const c = C.chapters[ci];
      const now = $('#now');
      now.classList.remove('in');
      void now.offsetWidth;
      now.classList.add('in');
      $('#chap-no').textContent = ['', '第一段', '第二段', '第三段', '第四段', '第五段', ''][ci] || '';
      $('#chap-name').textContent = c.name;
      $('#chap-desc').textContent = c.desc;
      [...labels.children].forEach((el, i) => el.classList.toggle('on', i === ci));
      lastUI.ci = ci;
    }
    const ph = phaseAt(t);
    if (force || ph !== lastUI.ph) {
      const el = $('#phase');
      el.textContent = ph || '';
      el.hidden = !ph;
      el.dataset.phase = ph || '';
      lastUI.ph = ph;
    }
    const s = Math.floor(t);
    if (force || s !== lastUI.s) {
      $('#clock').textContent = fmt(s);
      lastUI.s = s;
    }
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ------------------------------------------------------------------ 主循环
  let last = performance.now(), lastTarget = 0, inertia = 0, carry = 0;
  function nudge(dy) {                           // 滚动若干像素（累计小数，免得慢拖时丢步）
    carry += dy;
    const n = Math.trunc(carry);
    if (n) { window.scrollBy(0, n); carry -= n; }
  }
  function tick(now) {
    const dt = clamp((now - last) / 1000, 0.001, 0.1);
    last = now;
    if (S.auto) {
      S.target = Math.min(S.autoUntil, S.target + dt * S.autoRate);
      progY = Math.round(S.target * S.pxPerSec);
      window.scrollTo(0, progY);
      if (S.target >= S.autoUntil) stopAuto();
    }
    if (inertia) {
      nudge(inertia * dt * 1000);
      inertia *= Math.exp(-dt / 0.35);
      if (Math.abs(inertia) < 0.02) inertia = 0;
    }
    const inst = (S.target - lastTarget) / dt;
    lastTarget = S.target;
    S.vel += (inst - S.vel) * (1 - Math.exp(-dt / 0.15));
    drive();
    driveAudio(dt);
    driveMusic(dt);
    render(false);
    if (S.started && !S.auto && Math.abs(S.target - hintFrom) > 3) hideHint();
    requestAnimationFrame(tick);
  }

  addEventListener('scroll', () => {
    if (S.auto) {
      if (Math.abs(scrollY - progY) < 4) return;   // 自动展卷时滚动条是我们自己推的
      stopAuto();                                  // 别的来路（滚动条、查找、辅助功能）一律算接手
    }
    S.target = clamp(scrollY / S.pxPerSec, 0, END);
  }, { passive: true });

  // ------------------------------------------------------------------ 输入
  function userInput() {
    if (S.auto) stopAuto();
    if (!S.started) begin();
  }

  addEventListener('wheel', (e) => {
    userInput();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {   // 触控板横扫也算展卷
      e.preventDefault();
      nudge(e.deltaX * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? innerHeight : 1));
    }
  }, { passive: false });
  addEventListener('touchstart', (e) => {
    // 按在「展卷」上的那一下留给它自己的 click：这里先开场的话遮罩立刻 pointer-events:none，click 会落空
    if (e.target.closest && e.target.closest('#btn-open')) return;
    userInput();
  }, { passive: true });

  // 抓住画面左右拖（鼠标；手指横扫同理），松手带惯性
  let drag = null;
  paper.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    userInput();
    inertia = 0;
    drag = { id: e.pointerId, x: e.clientX, t: e.timeStamp, v: 0 };
    paper.setPointerCapture(e.pointerId);
    paper.classList.add('grabbing');
  });
  paper.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dt = Math.max(1, e.timeStamp - drag.t);
    drag.x = e.clientX; drag.t = e.timeStamp;
    nudge(-dx);
    drag.v = drag.v * 0.6 + (-dx / dt) * 0.4;
  });
  const endDrag = (e, fling) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (fling && !REDUCED && e.timeStamp - drag.t < 90) inertia = clamp(drag.v, -12, 12);
    drag = null;
    paper.classList.remove('grabbing');
  };
  paper.addEventListener('pointerup', (e) => endDrag(e, true));
  paper.addEventListener('pointercancel', (e) => endDrag(e, false));

  // 缩略条：点哪跳哪，按住拖动就是快速翻卷
  let scrub = false;
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    userInput();
    scrub = true;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('scrubbing');
    inertia = 0;
    window.scrollTo(0, timeAtBarX(e.clientX - bar.getBoundingClientRect().left) * S.pxPerSec);
  });
  bar.addEventListener('pointermove', (e) => {
    const x = e.clientX - bar.getBoundingClientRect().left;
    if (scrub) {
      inertia = 0;
      window.scrollTo(0, timeAtBarX(x) * S.pxPerSec);
    }
    if (e.target.classList.contains('poem')) return;
    const t = timeAtBarX(x), c = C.chapters[chapterAt(t)];
    showTip(x, `${c.name}<i>${fmt(t)}</i>`);
  });
  const endScrub = () => { scrub = false; bar.classList.remove('scrubbing'); };
  bar.addEventListener('pointerup', endScrub);
  bar.addEventListener('pointercancel', endScrub);
  bar.addEventListener('pointerleave', () => { if (!scrub) hideTip(); });

  function showTip(x, html, wide) {
    tip.innerHTML = html;
    tip.classList.toggle('wide', !!wide);
    tip.style.left = clamp(x, 60, S.bar.w - 60) + 'px';
    tip.classList.add('on');
  }
  function hideTip() { tip.classList.remove('on'); }

  function step(dir, big) {
    userInput();
    window.scrollBy({ top: dir * (big ? 10 : 2) * S.pxPerSec, behavior: REDUCED ? 'auto' : 'smooth' });
  }
  function jumpChapter(dir) {
    const ci = chapterAt(S.target);
    const c = C.chapters[clamp(ci + dir, 0, C.chapters.length - 1)];
    jumpTo(dir < 0 && S.target - C.chapters[ci].jump > 3 ? C.chapters[ci].jump : c.jump);
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); if (!S.started) begin(); toggleAuto(); }
    else if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); step(1, e.shiftKey); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); step(-1, e.shiftKey); }
    else if (k === 'PageDown') { e.preventDefault(); jumpChapter(1); }
    else if (k === 'PageUp') { e.preventDefault(); jumpChapter(-1); }
    else if (k === 'Home') { e.preventDefault(); jumpTo(0); }
    else if (k === 'End') { e.preventDefault(); jumpTo(END); }
    else if (k === 'm' || k === 'M') toggleMusic();
    else if (k === 'n' || k === 'N') toggleSound();
    else if (k === 'f' || k === 'F') toggleFs();
    else if (/^[1-9]$/.test(k) && C.chapters[+k - 1]) jumpTo(C.chapters[+k - 1].jump);
  });

  // 跳转：近的平滑滚过去，远的直接切，用定格画面淡出盖住 seek
  function jumpTo(t) {
    userInput();
    inertia = 0;
    t = clamp(t, 0, END);
    const far = Math.abs(t - S.target) > 12;
    if (far) crossfade();
    window.scrollTo({ top: t * S.pxPerSec, behavior: far || REDUCED ? 'auto' : 'smooth' });
  }

  let fadeTimer = 0;
  function crossfade() {
    if (video.readyState < 2 || freeze.classList.contains('on')) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    freeze.width = Math.min(M.width, Math.round(freeze.clientWidth * dpr));
    freeze.height = Math.round(freeze.width * M.height / M.width);
    freeze.getContext('2d').drawImage(video, 0, 0, freeze.width, freeze.height);
    freeze.classList.add('on');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(unfreeze, 1500);
  }
  function unfreeze() {
    clearTimeout(fadeTimer);
    requestAnimationFrame(() => freeze.classList.remove('on'));
  }
  video.addEventListener('seeked', () => { if (freeze.classList.contains('on')) unfreeze(); });

  // ------------------------------------------------------------------ 自动展卷 / 声音 / 画质 / 全屏
  function startAuto(until) {
    if (S.target >= END - 0.5) {                // 看到卷尾了，再按就从头来
      window.scrollTo(0, 0);
      S.target = 0;
    }
    S.auto = true;
    S.autoUntil = until ?? END;
    btnAuto.classList.add('on');
    btnAuto.querySelector('span').textContent = '暂停';
  }
  function stopAuto() {
    S.auto = false;
    btnAuto.classList.remove('on');
    btnAuto.querySelector('span').textContent = '自动展卷';
    S.target = hintFrom = clamp(scrollY / S.pxPerSec, 0, END);
  }
  function toggleAuto() { S.auto ? stopAuto() : startAuto(); }
  btnAuto.addEventListener('click', () => { if (!S.started) begin(); toggleAuto(); });

  const RATES = [0.5, 1, 2];
  btnRate.addEventListener('click', () => {
    S.autoRate = RATES[(RATES.indexOf(S.autoRate) + 1) % RATES.length];
    btnRate.textContent = S.autoRate + '×';
    if (!S.auto) startAuto();
  });

  function ensureCtx() {                       // 第一次要在点击 / 按键里调，AudioContext 才能出声
    if (!A.ctx && /^https?:$/.test(location.protocol)) {
      try {
        A.ctx = new (window.AudioContext || window.webkitAudioContext)();
        A.master = A.ctx.createGain();
        A.master.gain.value = 0;
        A.master.connect(A.ctx.destination);
      } catch (err) { A.ctx = null; }
    }
    if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume();
    return A.ctx;
  }

  function setSound(on) {
    S.sound = on;
    btnSound.classList.toggle('on', on);
    btnSound.querySelector('span').textContent = on ? '环境音 开' : '环境音 关';
    btnSound.setAttribute('aria-pressed', on);
    if (!on) return;
    if (ensureCtx()) loadAudio();
    if (!A.buf && audio.paused) {              // <audio> 先在点击里 play 一下解锁（Safari），不在动的话下一帧就停
      audio.volume = 0;
      audio.play().catch(() => {});
    }
  }
  function toggleSound() { setSound(!S.sound); }
  btnSound.addEventListener('click', toggleSound);

  // ------------------------------------------------------------------ 背景音乐
  // 两首按顺序循环播，和滚动无关。默认开：一进页面就试着播；浏览器不让（还没有点击 / 按键）就等第一次交互再播。
  // 音量用 <audio>.volume 渐入渐出；iOS 上 volume 只读，改走 Web Audio 增益（仅 http(s)，file:// 下会被当跨域静音）。
  // 实测 1 倍速播放、每帧改音量都不影响 <video> 每帧 seek（WebKit 里只有改 playbackRate 才会卡）。
  const bgm = $('#bgm'), btnMusic = $('#btn-music');
  const MU = { want: localStorage.getItem('qm.music') !== 'off', i: 0, lvl: 0, gain: null, blocked: false };
  const volReadOnly = (() => { const a = new Audio(); a.volume = 0.5; return a.volume === 1; })();

  function musicTrack(i) {
    MU.i = (i + C.music.length) % C.music.length;
    bgm.src = C.music[MU.i].src;
    musicUI();
  }
  function musicUI() {
    const t = C.music[MU.i].title;
    btnMusic.classList.toggle('on', MU.want && !MU.blocked);
    btnMusic.classList.toggle('wait', MU.want && MU.blocked);
    btnMusic.setAttribute('aria-pressed', MU.want);
    btnMusic.querySelector('span').textContent = MU.want ? '音乐 开' : '音乐 关';
    btnMusic.title = !MU.want ? '背景音乐已暂停（M 继续）'
      : MU.blocked ? `${t}：浏览器要先点一下页面才能出声（M）` : `正在播放 ${t}（M 暂停）`;
    $('#cover-music').textContent = !MU.want ? ''
      : MU.blocked ? '♪ 背景音乐《汴河画卷》展卷时响起' : `♪ 正在播放《${t}》`;
  }
  function musicPlay() {
    if (volReadOnly && !MU.gain && ensureCtx()) {
      MU.gain = A.ctx.createGain();
      MU.gain.gain.value = 0;
      A.ctx.createMediaElementSource(bgm).connect(MU.gain).connect(A.ctx.destination);
    }
    const p = bgm.play();
    if (p) p.then(() => { MU.blocked = false; musicUI(); },
      (err) => { if (err.name === 'NotAllowedError') { MU.blocked = true; musicUI(); } });
  }
  function setMusic(on) {
    MU.want = on;
    localStorage.setItem('qm.music', on ? 'on' : 'off');
    if (on) musicPlay();                       // 暂停由 driveMusic 淡出后再 pause
    musicUI();
  }
  function toggleMusic() {
    ensureCtx();
    if (MU.want && MU.blocked) musicPlay();    // 还在等手势的那次点击，是要它响，不是关掉
    else setMusic(!MU.want);
  }
  btnMusic.addEventListener('click', toggleMusic);
  bgm.addEventListener('ended', () => { musicTrack(MU.i + 1); if (MU.want) musicPlay(); });

  // 自动播放被拦了：第一次点击 / 按键 / 触摸时补上（滚轮不算浏览器认的"用户手势"）
  const unlock = (e) => {
    if (e.target === btnMusic || btnMusic.contains(e.target)) return;   // 点音乐按钮本身交给 toggleMusic
    if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume();
    if (MU.want && bgm.paused) musicPlay();
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, unlock, { capture: true, passive: true });

  function driveMusic(dt) {
    const duck = 1 - 0.45 * clamp(vol * C.ambienceGain, 0, 1);   // 滚动时环境音起来，音乐按环境音的响度让一让
    const want = MU.want && !bgm.paused ? Math.pow(10, C.music[MU.i].gain / 20) * duck : 0;
    MU.lvl += (want - MU.lvl) * (1 - Math.exp(-dt / (want > MU.lvl ? 0.7 : 0.18)));
    if (!MU.want && MU.lvl < 0.005) {
      MU.lvl = 0;
      if (!bgm.paused) bgm.pause();
    }
    if (MU.gain) MU.gain.gain.value = MU.lvl;
    else bgm.volume = clamp(MU.lvl, 0, 1);
  }

  function pickQuality() {
    const saved = localStorage.getItem('qm.q');
    if (saved === 'hd' || saved === 'sd') return saved;
    const px = Math.min(screen.width, innerWidth) * (devicePixelRatio || 1);
    const slow = navigator.connection && (navigator.connection.saveData || /2g/.test(navigator.connection.effectiveType));
    return px >= 1500 && !slow ? 'hd' : 'sd';
  }
  function setQuality(q) {
    if (S.q === q) return;
    if (S.q) crossfade();
    S.q = q;
    btnQ.textContent = q === 'hd' ? '高清' : '标清';
    btnQ.title = `${q === 'hd' ? '1080p' : '720p'} · ${Math.round(M.video[q].bytes / 1048576)} MB（点击切换）`;
    video.src = M.video[q].src;                // 载入后 drive() 会自己 seek 回 S.target
  }
  btnQ.addEventListener('click', () => {
    const q = S.q === 'hd' ? 'sd' : 'hd';
    localStorage.setItem('qm.q', q);
    setQuality(q);
  });

  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  if (document.fullscreenEnabled) btnFs.addEventListener('click', toggleFs);
  else btnFs.hidden = true;

  // ------------------------------------------------------------------ 载入进度
  const loadEl = $('#load');
  function onProgress() {
    if (!video.duration || !video.buffered.length) return;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) end = Math.max(end, video.buffered.end(i));
    const f = clamp(end / video.duration, 0, 1);
    buf.style.transform = `scaleX(${f})`;
    buf.classList.toggle('done', f > 0.995);
    if (!S.started) loadEl.textContent = f > 0.995 ? '已就绪' : `载入中 ${Math.round(f * 100)}%`;
  }
  video.addEventListener('progress', onProgress);
  video.addEventListener('canplay', () => {
    onProgress();
    if (!S.started && loadEl.textContent.startsWith('载入')) loadEl.textContent = '可以展卷了（边看边载入）';
  });
  video.addEventListener('error', () => {
    loadEl.textContent = '视频没有载入：先运行 build_web.py 生成 media/，再用 serve.py 或直接双击 index.html 打开';
    loadEl.classList.add('err');
  });

  // ------------------------------------------------------------------ 开场
  let hintFrom = 0, hintTimer = 0;
  function begin() {
    if (S.started) return;
    S.started = true;
    hintFrom = S.target;
    const cover = $('#cover');
    cover.classList.add('gone');
    setTimeout(() => { cover.hidden = true; }, 900);
    $('#hint').classList.add('on');
    hintTimer = setTimeout(hideHint, 9000);
  }
  function hideHint() { clearTimeout(hintTimer); $('#hint').classList.remove('on'); }
  $('#btn-open').addEventListener('click', () => {
    begin();
    setSound(true);                            // 不放进 begin：手机上 touchstart 会先一步以"无声"开场
    if (S.target < T_MAIN0) startAuto(T_MAIN0 + 1.5);   // 先替人把引首展开，再交给滚动
  });

  // ------------------------------------------------------------------ 启动
  history.scrollRestoration = 'manual';
  $('#total').textContent = fmt(DUR);
  pano.style.backgroundImage = `url(${M.pano.src})`;
  video.poster = M.poster;
  $('#cover-bg').style.backgroundImage = `url(${M.cover})`;
  audio.src = M.audio;
  musicTrack(0);
  if (MU.want) musicPlay();
  buildMarks();
  setQuality(pickQuality());
  const m = /t=([\d.]+)/.exec(location.hash);   // index.html#t=85 直接翻到第 85 秒
  if (m) S.target = clamp(parseFloat(m[1]), 0, END);
  layout();
  let rz = 0;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 100); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {                     // 切走就停；rAF 也停了，来不及淡出，直接 pause
      stopAuto(); video.pause(); audio.pause(); bgm.pause();
      MU.lvl = 0;
    } else if (MU.want) musicPlay();
  });
  requestAnimationFrame(tick);
  window.QM = { S, A, MU, jumpTo, startAuto, stopAuto, video, bgm };   // 调试用
})();
