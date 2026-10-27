/* Volleyball Hitting Analyzer - UI and video handling. Engine lives in analysis.js (window.VBA). */
(function () {
  'use strict';
  const VBA = window.VBA;
  const $ = (id) => document.getElementById(id);

  // MediaPipe Tasks Vision (Google). Loaded from the official CDN the first time you analyze.
  const TV_VERSION = '0.10.14';
  const TV_JS = [
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/vision_bundle.mjs`,
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/+esm`,
  ];
  const TV_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/wasm`;
  const MODEL_URL = (m) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/1/pose_landmarker_${m}.task`;

  const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120, 239.76, 240];
  const EVENTS = [
    { key: 'approachStart', name: 'Approach start', hot: 'A', color: 'var(--ev-approach)', hex: '#9a9a9a', optional: true },
    { key: 'takeoff', name: 'Take-off', hot: 'T', color: 'var(--ev-takeoff)', hex: '#4fb3ff' },
    { key: 'contact', name: 'Contact', hot: 'C', color: 'var(--ev-contact)', hex: '#ffc83d' },
    { key: 'landing', name: 'Landing', hot: 'L', color: 'var(--ev-landing)', hex: '#b48cff' },
  ];
  const C = { hitter: '#ffc83d', joint: '#ffffff', other: 'rgba(255,255,255,0.38)', ball: '#ff7a45', s1: '#3987e5', s2: '#d95926',
    grid: '#2a2c31', axis: '#7c7b75', text2: '#b0afa8', text: '#ecebe7', panel: '#17181b', calib: '#3ecf8e' };

  // ---------- DOM ----------
  const video = $('srcVideo'), view = $('view'), vctx = view.getContext('2d');
  const stage = $('stage');

  // ---------- state ----------
  const state = {
    file: null, videoReady: false, vw: 0, vh: 0, duration: 0, fps: 30, fpsAuto: null, nFrames: 0,
    frame: 0, shownFrame: -1, playing: false,
    frames: null, shifts: null, S: null, range: null, analyzed: false,
    hitterIdx: null, hp: null, auto: null,
    events: {}, eventsManual: {},
    ball: {}, ballR: 14, ballRUser: false,
    calib: null, metrics: null,
    mode: null, hover: null,
    zoom: 1, cx: 0, cy: 0,
    landmarker: null, landmarkerModel: null, modelBuffer: null, ts: 0,
    cancel: false, busy: false, pendingAnalysis: null,
  };

  // ---------- settings ----------
  const DEFAULTS = { heightCm: 175, reachCm: null, camera: 'handheld', units: 'metric', scale: 'body', lineLen: '2.43', customLen: 1, model: 'full' };
  let settings = Object.assign({}, DEFAULTS);
  try { Object.assign(settings, JSON.parse(localStorage.getItem('vb-analyzer-settings') || '{}')); } catch (e) { /* storage unavailable */ }
  function saveSettings() { try { localStorage.setItem('vb-analyzer-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  // ---------- small UI helpers ----------
  let toastTimer = null;
  function toast(msg, isError, ms) {
    let el = stage.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; stage.appendChild(el); }
    el.textContent = msg; el.classList.toggle('error', !!isError); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms || (isError ? 7000 : 3000));
  }
  function busy(on, title, sub) {
    state.busy = on; $('busy').hidden = !on;
    if (on) { state.cancel = false; $('busyTitle').textContent = title || 'Working…'; $('busySub').textContent = sub || ''; $('busyBar').style.width = '0%'; }
    updateButtons();
  }
  function progress(frac, sub) { $('busyBar').style.width = Math.round(frac * 100) + '%'; if (sub != null) $('busySub').textContent = sub; }
  $('busyCancel').onclick = () => { state.cancel = true; $('busySub').textContent = 'Stopping…'; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const fmtTime = (f) => (f / state.fps).toFixed(2) + ' s';

  // ---------- units ----------
  const KIND = { jumpHeight: 'len', riseAtContact: 'len', contactHeight: 'lenBig', flightTime: 'ms', contactTiming: 'ms', elbowAtContact: 'deg',
    shoulderAtContact: 'deg', plantKnee: 'deg', landingKnee: 'deg', landingGap: 'ms', handSpeed: 'speed', ballSpeed: 'speed', ballAngle: 'deg',
    approachTime: 's', approachSpeed: 'speed1' };
  function fmtValue(key, m) {
    if (!m || !isNum(m.v)) return null;
    const v = m.v, imp = settings.units === 'imperial';
    switch (KIND[key]) {
      case 'len': return imp ? { n: (v * 39.37).toFixed(1), u: 'in' } : { n: String(Math.round(v * 100)), u: 'cm' };
      case 'lenBig': if (imp) { const inch = v * 39.37; return { n: Math.floor(inch / 12) + '′ ' + Math.round(inch % 12) + '″', u: '' }; } return { n: v.toFixed(2), u: 'm' };
      case 'ms': return { n: (m.signed && v > 0 ? '+' : '') + Math.round(v), u: 'ms' };
      case 'deg': return { n: String(Math.round(v)), u: '°' };
      case 'speed': return imp ? { n: (v * 2.237).toFixed(0), u: 'mph' } : { n: (v * 3.6).toFixed(0), u: 'km/h' };
      case 'speed1': return imp ? { n: (v * 2.237).toFixed(1), u: 'mph' } : { n: v.toFixed(1), u: 'm/s' };
      case 's': return { n: v.toFixed(2), u: 's' };
      default: return { n: String(Math.round(v * 100) / 100), u: m.unit || '' };
    }
  }

  // =====================================================================
  // Video loading
  // =====================================================================
  function resetAnalysis() {
    Object.assign(state, { frames: null, shifts: null, S: null, range: null, analyzed: false, hitterIdx: null, hp: null, auto: null,
      events: {}, eventsManual: {}, ball: {}, calib: null, metrics: null, ballRUser: false });
  }

  function openVideo(file) {
    if (!file) return;
    stopPlayback();
    resetAnalysis();
    state.file = file; state.videoReady = false;
    $('fileName').textContent = file.name;
    $('dropHint').hidden = false;
    $('dropHint').querySelector('h1').textContent = 'Loading video…';
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
    video.load();
    clearTimeout(state.loadTimer);
    state.loadTimer = setTimeout(() => { if (!state.videoReady) videoUnsupported(); }, 12000);
    renderAll();
  }

  function videoUnsupported() {
    state.videoReady = false;
    const h = $('dropHint');
    h.hidden = false;
    h.querySelector('h1').textContent = 'This browser can\'t play that video';
    h.querySelector('div').innerHTML = 'iPhone videos are often HEVC/HDR, which Chrome on some PCs can\'t decode. Fixes: use the <b>_compatible.mp4</b> copy, set iPhone <b>Settings → Camera → Formats → Most Compatible</b> for future clips, or convert the clip to MP4 (H.264).';
    $('analyzeStatus').textContent = 'Video could not be decoded.';
    $('analyzeStatus').className = 'status err';
    updateButtons();
  }

  video.addEventListener('error', () => { if (state.file) videoUnsupported(); });
  video.addEventListener('loadeddata', async () => {
    if (state.videoReady || !video.videoWidth) { if (!video.videoWidth) videoUnsupported(); return; }
    clearTimeout(state.loadTimer);
    state.vw = video.videoWidth; state.vh = video.videoHeight; state.duration = video.duration;
    state.cx = state.vw / 2; state.cy = state.vh / 2; state.zoom = 1;
    const fps = await detectFps();
    state.fpsAuto = fps;
    setFps(fps || 30, true);
    state.videoReady = true;
    $('dropHint').hidden = true;
    $('dropHint').querySelector('h1').textContent = 'Drop a hitting video here';
    if (!state.ballRUser) setBallR(Math.round(state.vh * 0.013));
    $('analyzeStatus').textContent = (fps ? 'Detected ' + fmtFps(fps) + ' fps. ' : 'Frame rate unknown, assuming 30 fps. ') + 'Press Analyze video.';
    $('analyzeStatus').className = 'status';
    await seekExact(0);
    if (state.pendingAnalysis) applyAnalysis(state.pendingAnalysis);
    renderAll();
  });

  function fmtFps(f) { return Number.isInteger(f) ? String(f) : f.toFixed(2); }

  /** Estimate frame rate by watching decoded frame timestamps during slow playback. */
  function detectFps() {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const times = [];
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        video.pause();
        const d = [];
        for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 0.0005) d.push(x); }
        if (d.length < 3) return resolve(null);
        d.sort((a, b) => a - b);
        const raw = 1 / d[Math.floor(d.length * 0.25)];
        let best = null;
        for (const o of FPS_OPTIONS) if (Math.abs(o - raw) / o < 0.04 && (!best || Math.abs(o - raw) < Math.abs(best - raw))) best = o;
        resolve(best || Math.round(raw));
      };
      const cb = (now, meta) => { times.push(meta.mediaTime); if (times.length >= 14) finish(); else video.requestVideoFrameCallback(cb); };
      video.requestVideoFrameCallback(cb);
      video.muted = true; video.playbackRate = 0.25;
      video.play().catch(finish);
      setTimeout(finish, 3000);
    });
  }

  function setFps(fps, fromLoad) {
    const changed = state.fps !== fps;
    state.fps = fps;
    state.nFrames = Math.max(1, Math.round(state.duration * fps));
    const sel = $('fpsSel');
    const opts = FPS_OPTIONS.slice();
    if (!opts.includes(fps)) opts.push(fps);
    opts.sort((a, b) => a - b);
    sel.innerHTML = opts.map((o) => `<option value="${o}" ${o === fps ? 'selected' : ''}>${fmtFps(o)}${o === state.fpsAuto ? ' (auto)' : ''}</option>`).join('');
    if (changed && !fromLoad && state.analyzed) {
      resetAnalysis();
      toast('Frame rate changed. Please analyze the video again.');
    }
    state.frame = clamp(state.frame, 0, state.nFrames - 1);
  }
  $('fpsSel').onchange = (e) => { setFps(parseFloat(e.target.value)); requestFrame(state.frame); renderAll(); };

  // =====================================================================
  // Seeking & playback
  // =====================================================================
  const frameTime = (f) => Math.min((f + 0.5) / state.fps, Math.max(0, state.duration - 0.001));

  function seekExact(f) {
    f = clamp(f, 0, state.nFrames - 1);
    return new Promise((resolve) => {
      const t = frameTime(f);
      let done = false;
      const finish = () => { if (done) return; done = true; state.shownFrame = f; resolve(); };
      if (Math.abs(video.currentTime - t) < 1e-6 && video.readyState >= 2 && !video.seeking) { finish(); return; }
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        if (video.requestVideoFrameCallback) { video.requestVideoFrameCallback(() => finish()); setTimeout(finish, 80); }
        else setTimeout(finish, 20);
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = t;
      setTimeout(() => { video.removeEventListener('seeked', onSeeked); finish(); }, 4000);
    });
  }

  let pumping = false, wantFrame = null;
  function requestFrame(f) {
    if (!state.videoReady) return;
    f = clamp(Math.round(f), 0, state.nFrames - 1);
    state.frame = f; wantFrame = f;
    updateReadout(); drawTimeline(); drawCharts();
    if (!pumping) pump();
  }
  async function pump() {
    pumping = true;
    while (wantFrame != null) {
      const f = wantFrame; wantFrame = null;
      await seekExact(f);
      render();
    }
    pumping = false;
  }

  function play() {
    if (!state.videoReady || state.busy) return;
    if (state.frame >= state.nFrames - 1) { state.frame = 0; video.currentTime = frameTime(0); }
    video.playbackRate = parseFloat($('speedSel').value);
    video.play().then(() => { state.playing = true; setPlayIcon(); loop(); }).catch(() => {});
  }
  function stopPlayback() {
    if (!state.playing) return;
    state.playing = false; video.pause(); setPlayIcon();
    requestFrame(state.frame);
  }
  function setPlayIcon() { $('icPlay').style.display = state.playing ? 'none' : ''; $('icPause').style.display = state.playing ? '' : 'none'; }
  function loop() {
    if (!state.playing) return;
    const step = (mediaTime) => {
      if (!state.playing) return;
      state.frame = state.shownFrame = clamp(Math.floor(mediaTime * state.fps + 0.02), 0, state.nFrames - 1);
      render(); updateReadout(); drawTimeline(); drawCharts();
      loop();
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback((now, meta) => step(meta.mediaTime));
    else requestAnimationFrame(() => step(video.currentTime));
  }
  video.addEventListener('ended', () => { state.playing = false; setPlayIcon(); state.frame = state.nFrames - 1; requestFrame(state.frame); });
  $('speedSel').onchange = () => { video.playbackRate = parseFloat($('speedSel').value); };

  $('bPlay').onclick = () => (state.playing ? stopPlayback() : play());
  $('bFirst').onclick = () => { stopPlayback(); requestFrame(0); };
  $('bBack10').onclick = () => { stopPlayback(); requestFrame(state.frame - 10); };
  $('bBack1').onclick = () => { stopPlayback(); requestFrame(state.frame - 1); };
  $('bFwd1').onclick = () => { stopPlayback(); requestFrame(state.frame + 1); };
  $('bFwd10').onclick = () => { stopPlayback(); requestFrame(state.frame + 10); };

  function updateReadout() {
    if (!state.videoReady) { $('readout').innerHTML = 'Frame <b>–</b>'; return; }
    let s = `Frame <b>${state.frame}</b> / ${state.nFrames - 1} · ${fmtTime(state.frame)}`;
    if (isNum(state.events.takeoff)) {
      const d = (state.frame - state.events.takeoff) / state.fps;
      s += ` · <span title="time relative to take-off">${d >= 0 ? '+' : ''}${d.toFixed(2)} s</span>`;
    }
    $('readout').innerHTML = s;
  }

  // =====================================================================
  // Rendering the video + overlays
  // =====================================================================
  function syncCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return dpr;
  }
  function viewTransform() {
    const cw = view.width, ch = view.height;
    const s0 = Math.min(cw / state.vw, ch / state.vh);
    const s = s0 * state.zoom;
    if (state.zoom <= 1.0001) { state.cx = state.vw / 2; state.cy = state.vh / 2; }
    else {
      const hw = cw / 2 / s, hh = ch / 2 / s;
      state.cx = state.vw / 2 + clamp(state.cx - state.vw / 2, -Math.max(0, state.vw / 2 - hw), Math.max(0, state.vw / 2 - hw));
      state.cy = state.vh / 2 + clamp(state.cy - state.vh / 2, -Math.max(0, state.vh / 2 - hh), Math.max(0, state.vh / 2 - hh));
    }
    return { s, ox: cw / 2 - state.cx * s, oy: ch / 2 - state.cy * s };
  }
  function toVideo(clientX, clientY) {
    const r = view.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, T = viewTransform();
    return [((clientX - r.left) * dpr - T.ox) / T.s, ((clientY - r.top) * dpr - T.oy) / T.s];
  }

  function render() {
    const dpr = syncCanvas(view);
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.fillStyle = '#000'; vctx.fillRect(0, 0, view.width, view.height);
    if (!state.videoReady) return;
    const T = viewTransform();
    vctx.drawImage(video, T.ox, T.oy, state.vw * T.s, state.vh * T.s);
    drawOverlays(vctx, T, state.frame, dpr);
    $('zoomChip').hidden = state.zoom <= 1.0001;
    $('zoomChip').textContent = state.zoom.toFixed(1) + '× · double-click to reset';
  }

  function hitterPose(f) { return state.hp && state.hp[f] ? state.hp[f] : null; }

  function drawSkeleton(ctx, T, pose, color, width, dots, dashed) {
    const P = (i) => [T.ox + pose.lm[i][0] * T.s, T.oy + pose.lm[i][1] * T.s];
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    ctx.setLineDash(dashed ? [width * 2, width * 2] : []);
    ctx.beginPath();
    for (const [a, b] of VBA.CONNECTIONS) {
      if (!pose.lm[a] || !pose.lm[b]) continue;
      const pa = P(a), pb = P(b); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
    }
    ctx.stroke(); ctx.setLineDash([]);
    if (dots) {
      ctx.fillStyle = C.joint;
      for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { const p = P(i); ctx.beginPath(); ctx.arc(p[0], p[1], width * 0.9, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  function label(ctx, x, y, text, k, color) {
    ctx.font = `600 ${12 * k}px ${getComputedStyle(document.body).fontFamily}`;
    const w = ctx.measureText(text).width + 10 * k, h = 18 * k;
    ctx.fillStyle = 'rgba(15,16,18,0.82)';
    roundRect(ctx, x - w / 2, y - h / 2, w, h, 5 * k); ctx.fill();
    if (color) { ctx.strokeStyle = color; ctx.lineWidth = 1 * k; ctx.stroke(); }
    ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5 * k);
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function drawOverlays(ctx, T, f, k) {
    const fr = state.frames && state.frames[f];
    // Other people
    if ($('tOthers').checked && fr) {
      fr.poses.forEach((p, i) => { if (!state.hitterIdx || state.hitterIdx[f] !== i) drawSkeleton(ctx, T, p, C.other, 1.5 * k, false); });
    }
    // Pick mode: outline everyone
    if (state.mode === 'pick' && fr) {
      fr.poses.forEach((p) => {
        const b = VBA.poseBox(p); if (!b) return;
        ctx.strokeStyle = C.hitter; ctx.lineWidth = 1.5 * k; ctx.setLineDash([6 * k, 4 * k]);
        ctx.strokeRect(T.ox + (b.x0 - 0.1 * b.w) * T.s, T.oy + (b.y0 - 0.05 * b.h) * T.s, b.w * 1.2 * T.s, b.h * 1.1 * T.s);
        ctx.setLineDash([]);
        drawSkeleton(ctx, T, p, C.other, 1.5 * k, false);
      });
    }
    // Hitter
    const hp = hitterPose(f);
    if (hp && $('tSkel').checked) drawSkeleton(ctx, T, hp, C.hitter, 3 * k, true, hp.interpolated);
    if (hp && $('tAngles').checked) {
      const side = state.events.side;
      const at = (i) => [T.ox + hp.lm[i][0] * T.s, T.oy + hp.lm[i][1] * T.s];
      for (const s of ['L', 'R']) {
        const a = VBA.kneeAngle(hp, s); const p = at(VBA.SIDES[s].kn);
        if (isNum(a)) label(ctx, p[0] + 26 * k * (s === 'L' ? -1 : 1), p[1], Math.round(a) + '°', k);
      }
      if (side) {
        const a = VBA.elbowAngle(hp, side); const p = at(VBA.SIDES[side].el);
        if (isNum(a)) label(ctx, p[0] + 28 * k, p[1], Math.round(a) + '°', k, C.hitter);
      }
    }
    // Ball trail
    if ($('tBall').checked) {
      const keys = Object.keys(state.ball).map(Number).sort((a, b) => a - b);
      const near = keys.filter((q) => Math.abs(q - f) <= Math.round(state.fps * 1.2));
      ctx.lineWidth = 2 * k; ctx.strokeStyle = 'rgba(255,122,69,0.55)';
      ctx.beginPath();
      near.forEach((q, i) => { const b = state.ball[q]; const x = T.ox + b.x * T.s, y = T.oy + b.y * T.s; if (i && q - near[i - 1] <= 3) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      for (const q of near) {
        const b = state.ball[q], x = T.ox + b.x * T.s, y = T.oy + b.y * T.s;
        if (q === f) {
          ctx.strokeStyle = C.ball; ctx.lineWidth = 2.5 * k;
          ctx.beginPath(); ctx.arc(x, y, Math.max(6 * k, state.ballR * T.s * 1.25), 0, Math.PI * 2); ctx.stroke();
        } else {
          ctx.fillStyle = b.manual ? C.ball : 'rgba(255,122,69,0.8)';
          ctx.beginPath(); ctx.arc(x, y, 3 * k, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    // Ball-size preview under the cursor
    if (state.mode === 'ball' && state.hover && ctx === vctx) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1 * k; ctx.setLineDash([3 * k, 3 * k]);
      ctx.beginPath(); ctx.arc(T.ox + state.hover[0] * T.s, T.oy + state.hover[1] * T.s, state.ballR * T.s, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    // Calibration line
    const cal = state.calib;
    if (cal && cal.p1 && (settings.scale === 'line' || state.mode === 'calib')) {
      const a = [T.ox + cal.p1[0] * T.s, T.oy + cal.p1[1] * T.s];
      const b = cal.p2 ? [T.ox + cal.p2[0] * T.s, T.oy + cal.p2[1] * T.s] : (state.hover ? [T.ox + state.hover[0] * T.s, T.oy + state.hover[1] * T.s] : a);
      ctx.strokeStyle = C.calib; ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 4 * k, 0, Math.PI * 2); ctx.fillStyle = C.calib; ctx.fill(); }
      if (cal.p2) label(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14 * k, lineLenM().toFixed(2) + ' m', k, C.calib);
    }
    // Event chip
    const ev = EVENTS.find((e) => state.events[e.key] === f);
    if (ev) {
      ctx.font = `700 ${13 * k}px ${getComputedStyle(document.body).fontFamily}`;
      const text = ev.name.toUpperCase(), w = ctx.measureText(text).width + 20 * k;
      ctx.fillStyle = ev.hex; roundRect(ctx, 12 * k, 12 * k, w, 24 * k, 6 * k); ctx.fill();
      ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, 22 * k, 24.5 * k);
    }
  }

  // =====================================================================
  // Pointer: click actions, zoom & pan
  // =====================================================================
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (!state.videoReady || state.busy) return;
    drag = { x: e.clientX, y: e.clientY, cx: state.cx, cy: state.cy, moved: false, button: e.button };
    view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove', (e) => {
    if (!state.videoReady) return;
    state.hover = toVideo(e.clientX, e.clientY);
    if (drag && drag.button === 0) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved && state.zoom > 1) {
        const dpr = window.devicePixelRatio || 1, s = viewTransform().s;
        state.cx = drag.cx - dx * dpr / s; state.cy = drag.cy - dy * dpr / s;
      }
    }
    if (state.mode || (drag && drag.moved)) render();
  });
  view.addEventListener('pointerleave', () => { state.hover = null; if (state.mode) render(); });
  view.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved && d.button === 0) handleClick(toVideo(e.clientX, e.clientY));
  });
  view.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (state.mode === 'ball' && state.ball[state.frame]) { delete state.ball[state.frame]; ballChanged(); }
  });
  view.addEventListener('wheel', (e) => {
    if (!state.videoReady) return;
    e.preventDefault();
    const before = toVideo(e.clientX, e.clientY);
    state.zoom = clamp(state.zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 8);
    const r = view.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const s = Math.min(view.width / state.vw, view.height / state.vh) * state.zoom;
    state.cx = before[0] - ((e.clientX - r.left) * dpr - view.width / 2) / s;
    state.cy = before[1] - ((e.clientY - r.top) * dpr - view.height / 2) / s;
    render();
  }, { passive: false });
  view.addEventListener('dblclick', () => { state.zoom = 1; render(); });

  function handleClick(p) {
    if (p[0] < 0 || p[1] < 0 || p[0] > state.vw || p[1] > state.vh) return;
    if (state.mode === 'ball') {
      state.ball[state.frame] = { x: p[0], y: p[1], manual: true };
      ballChanged();
    } else if (state.mode === 'calib') {
      if (!state.calib || state.calib.p2) state.calib = { p1: p, p2: null, frame: state.frame };
      else { state.calib.p2 = p; setMode(null); settings.scale = 'line'; saveSettings(); syncSetupInputs(); computeAndRender(); }
      render();
    } else if (state.mode === 'pick') {
      const fr = state.frames && state.frames[state.frame];
      const pi = VBA.poseAtPoint(fr, p[0], p[1]);
      if (pi < 0) { toast('No detected person here. Try a frame where they are clearly visible.', true); return; }
      setMode(null);
      setHitter(state.frame, pi);
      toast('Hitter updated.');
    }
  }

  function setMode(m) {
    if (state.mode === m) m = null;
    if (m === 'calib') state.calib = null;
    state.mode = m;
    stage.classList.toggle('mode-ball', m === 'ball');
    stage.classList.toggle('mode-calib', m === 'calib');
    stage.classList.toggle('mode-pick', m === 'pick');
    const banner = $('modeBanner');
    const txt = { ball: 'Click the centre of the ball · right-click removes · <kbd>Esc</kbd> done',
      calib: 'Click both ends of something with a known length (e.g. top of net to floor) · <kbd>Esc</kbd> cancel',
      pick: 'Click the hitter · <kbd>Esc</kbd> cancel' }[m];
    banner.hidden = !txt; banner.innerHTML = txt || '';
    $('btnBallMode').classList.toggle('active', m === 'ball');
    $('btnPick').classList.toggle('active', m === 'pick');
    $('btnDrawLine').classList.toggle('active', m === 'calib');
    render();
  }
  $('btnBallMode').onclick = () => setMode('ball');
  $('btnPick').onclick = () => setMode('pick');
  $('btnDrawLine').onclick = () => setMode('calib');

  // =====================================================================
  // Pose model + analysis
  // =====================================================================
  let visionMod = null, fileset = null;
  async function getLandmarker() {
    if (window.__vbMockPoseLandmarker) return window.__vbMockPoseLandmarker;
    const model = settings.model;
    const key = model + (state.modelBuffer ? ':file' : '');
    if (state.landmarker && state.landmarkerModel === key) return state.landmarker;
    if (!visionMod) {
      for (const u of TV_JS) { try { visionMod = await import(u); break; } catch (e) { console.warn('load failed', u, e); } }
      if (!visionMod) { const err = new Error('lib'); err.kind = 'lib'; throw err; }
    }
    const lib = visionMod.PoseLandmarker ? visionMod : visionMod.default;
    if (!fileset) fileset = await lib.FilesetResolver.forVisionTasks(TV_WASM);
    const base = state.modelBuffer ? { modelAssetBuffer: state.modelBuffer } : { modelAssetPath: MODEL_URL(model) };
    const opts = (delegate) => ({ baseOptions: Object.assign({ delegate }, base), runningMode: 'VIDEO', numPoses: 4,
      minPoseDetectionConfidence: 0.35, minPosePresenceConfidence: 0.35, minTrackingConfidence: 0.35, outputSegmentationMasks: false });
    let lm;
    try { lm = await lib.PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch (e) {
      console.warn('GPU delegate failed, using CPU', e);
      try { lm = await lib.PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
      catch (e2) { const err = new Error('model'); err.kind = 'model'; err.cause = e2; throw err; }
    }
    if (state.landmarker && state.landmarker.close) { try { state.landmarker.close(); } catch (e) { /* ignore */ } }
    state.landmarker = lm; state.landmarkerModel = key; state.ts = 0;
    return lm;
  }

  function grayFrom(canvas, ctx) {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const g = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return g;
  }
  const smallCanvas = document.createElement('canvas'), sctx = smallCanvas.getContext('2d', { willReadFrequently: true });
  function sizeSmall() { smallCanvas.width = 320; smallCanvas.height = Math.round(320 * state.vh / state.vw / 2) * 2; }

  /**
   * Visit every frame in [a, b] and call onFrame(f) while that frame is drawable.
   * Plays the video slowly and grabs frames as they are presented (fast: decodes sequentially),
   * then seeks to any frame that was skipped.
   */
  async function captureRange(a, b, onFrame) {
    const done = new Uint8Array(b - a + 1);
    await seekExact(a);
    onFrame(a); done[0] = 1;
    if (b > a && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      await new Promise((resolve) => {
        let finished = false, watchdog = null, rate = Math.min(1, 8 / state.fps);
        const end = () => { if (finished) return; finished = true; clearTimeout(watchdog); video.pause(); video.removeEventListener('ended', end); resolve(); };
        const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(end, 4000); };
        const cb = (now, meta) => {
          if (finished) return;
          if (state.cancel) return end();
          const f = Math.round(meta.mediaTime * state.fps);
          if (f >= a && f <= b && !done[f - a]) {
            const t = performance.now();
            onFrame(f); done[f - a] = 1;
            const proc = (performance.now() - t) / 1000;
            // keep presentation slower than processing so frames aren't skipped
            const ideal = Math.max(0.0625, Math.min(1, 0.6 / (state.fps * Math.max(proc, 0.004))));
            rate = rate * 0.7 + ideal * 0.3;
            video.playbackRate = Math.max(0.0625, rate);
          }
          if (f >= b) return end();
          arm();
          video.requestVideoFrameCallback(cb);
        };
        video.addEventListener('ended', end);
        video.requestVideoFrameCallback(cb);
        video.muted = true; video.playbackRate = rate;
        arm();
        video.play().catch(end);
      });
    }
    let filled = 0;
    for (let f = a; f <= b; f++) {
      if (state.cancel) break;
      if (done[f - a]) continue;
      await seekExact(f);
      onFrame(f); done[f - a] = 1; filled++;
    }
    if (filled) console.info('frames filled by seeking:', filled);
    state.lastCaptureStats = { total: b - a + 1, filled };
  }

  async function analyze() {
    if (!state.videoReady || state.busy) return;
    stopPlayback(); setMode(null);
    busy(true, 'Loading body-tracking model…', 'First time only: downloads about 10 MB from Google\'s MediaPipe servers.');
    let lm;
    try { lm = await getLandmarker(); }
    catch (e) {
      busy(false);
      const st = $('analyzeStatus');
      st.className = 'status err';
      console.error('pose model load failed', e, e.cause);
      const detail = esc(String((e.cause && (e.cause.message || e.cause)) || e.message || e)).slice(0, 200);
      if (e.kind === 'lib') st.innerHTML = 'Couldn\'t load the body-tracking library. It needs an internet connection the first time. Check your connection and try again.';
      else st.innerHTML = `Couldn't load the pose model. Check your internet connection and try again, or download the model file <a href="${MODEL_URL(settings.model)}" target="_blank" rel="noopener" style="color:var(--accent)">here</a> and <a href="#" id="pickModel" style="color:var(--accent)">choose it</a>.<br><span style="color:var(--muted)">Details: ${detail}</span>`;
      const pm = document.getElementById('pickModel'); if (pm) pm.onclick = (ev) => { ev.preventDefault(); $('modelInput').click(); };
      return;
    }
    const n = state.nFrames, fps = state.fps;
    let a = 0, b = n - 1;
    if ($('rangeSel').value === 'around') { a = Math.max(0, state.frame - Math.round(fps)); b = Math.min(n - 1, state.frame + Math.round(fps)); }
    const keepBall = state.ball, keepCalib = state.calib;
    resetAnalysis();
    state.ball = keepBall; state.calib = keepCalib;
    state.frames = new Array(n).fill(null); state.shifts = new Array(n).fill(null); state.range = [a, b];
    const pw = Math.min(state.vw, 1280), ph = Math.round(state.vh * pw / state.vw);
    const proc = document.createElement('canvas'); proc.width = pw; proc.height = ph;
    const pctx = proc.getContext('2d');
    sizeSmall();
    const sw = smallCanvas.width, sh = smallCanvas.height, kx = sw / state.vw, ky = sh / state.vh;
    const grays = new Map();
    let detectErrors = 0, lastDetectError = null;
    const total = b - a + 1;
    let count = 0;
    const t0 = performance.now();
    $('busyTitle').textContent = 'Analyzing body movement…';
    const onFrame = (f) => {
      state.capFrame = f;
      pctx.drawImage(video, 0, 0, pw, ph);
      state.ts += 1000 / fps;
      let poses = null;
      const convert = (res) => {
        const out = [];
        if (res && res.landmarks) {
          res.landmarks.forEach((lms, i) => {
            const w = res.worldLandmarks && res.worldLandmarks[i];
            out.push({ lm: lms.map((p) => [p.x * state.vw, p.y * state.vh, p.visibility == null ? 1 : p.visibility]), w: w ? w.map((p) => [p.x, p.y, p.z]) : null });
          });
        }
        return out;
      };
      try {
        // callback form works on every tasks-vision version; results are copied inside the callback
        const ret = lm.detectForVideo(proc, state.ts, (res) => { poses = convert(res); });
        if (!poses && ret) poses = convert(ret);
      } catch (e) { detectErrors++; if (detectErrors < 4) console.warn('detect failed at frame', f, e); lastDetectError = e; }
      state.frames[f] = { poses: poses || [] };
      sctx.drawImage(proc, 0, 0, sw, sh);
      grays.set(f, grayFrom(smallCanvas, sctx));
      count++;
      const eta = (performance.now() - t0) / count * (total - count) / 1000;
      progress(count / total * 0.9, `Frame ${count} of ${total}${count > 8 ? ` · about ${Math.ceil(eta)} s left` : ''}`);
      if (count % 4 === 0) { state.frame = f; state.shownFrame = f; render(); updateReadout(); }
    };
    await captureRange(a, b, onFrame);
    // camera movement between consecutive frames, people masked out
    if (!state.cancel) {
      $('busySub').textContent = 'Measuring camera movement…';
      const boxesOf = (f) => (state.frames[f] ? state.frames[f].poses.map(VBA.poseBox).filter(Boolean).map((bx) => ({ x0: (bx.x0 - 0.2 * bx.w) * kx, x1: (bx.x1 + 0.2 * bx.w) * kx, y0: (bx.y0 - 0.15 * bx.h) * ky, y1: (bx.y1 + 0.1 * bx.h) * ky })) : []);
      for (let f = a + 1; f <= b; f++) {
        const g0 = grays.get(f - 1), g1 = grays.get(f);
        if (!g0 || !g1) continue;
        const s = VBA.estimateShift(g0, g1, sw, sh, VBA.makeMask(sw, sh, boxesOf(f - 1).concat(boxesOf(f))), 16);
        state.shifts[f] = s ? [s.dx / kx, s.dy / ky] : [0, 0];
        if ((f - a) % 20 === 0) { progress(0.9 + 0.1 * (f - a) / total); await new Promise((r) => setTimeout(r, 0)); }
      }
    }
    grays.clear();
    const cancelled = state.cancel;
    busy(false);
    if (cancelled) { resetAnalysis(); state.ball = keepBall; state.calib = keepCalib; $('analyzeStatus').textContent = 'Analysis cancelled.'; $('analyzeStatus').className = 'status'; renderAll(); return; }
    if (detectErrors >= total) {
      $('analyzeStatus').className = 'status err';
      $('analyzeStatus').textContent = 'Body tracking failed on every frame: ' + (lastDetectError && lastDetectError.message || lastDetectError) + '. Try the Lite model, or reload the page.';
      renderAll(); return;
    }
    state.analyzed = true;
    postAnalysis();
  }
  $('btnAnalyze').onclick = analyze;

  function postAnalysis() {
    const n = state.nFrames;
    state.S = VBA.cumulativeShift(state.shifts, n);
    const tracks = VBA.buildTracks(state.frames, state.S);
    const [a, b] = state.range;
    const t = VBA.pickHitterTrack(tracks, b - a + 1, state.vh);
    const st = $('analyzeStatus');
    if (!t) {
      st.className = 'status err'; st.textContent = 'No person was detected. Make sure the whole body is visible, then try the Heavy model.';
      renderAll(); return;
    }
    let seedF = null, seedP = -1, bestH = 0;
    for (const [f, pi] of Object.entries(t.map)) { const bx = VBA.poseBox(state.frames[f].poses[pi]); if (bx && bx.h > bestH) { bestH = bx.h; seedF = +f; seedP = pi; } }
    setHitter(seedF, seedP, true);
  }

  function setHitter(f, pi, fromAuto) {
    state.hitterIdx = VBA.followFromSeed(state.frames, state.S, f, pi);
    state.eventsManual = Object.assign({}, state.eventsManual.approachStart != null ? { approachStart: true } : {});
    recompute(true);
    const found = state.hitterIdx.filter((x) => x >= 0).length, [a, b] = state.range;
    const st = $('analyzeStatus');
    const evOk = isNum(state.events.takeoff) && isNum(state.events.landing);
    st.className = 'status ' + (evOk ? 'ok' : 'err');
    st.textContent = `Hitter tracked in ${found} of ${b - a + 1} frames. ` + (evOk ? (state.auto && state.auto.confidence === 'ok' ? 'Key moments found. Check them below.' : 'Key moments found but uncertain. Please check them.') : 'Could not find the jump automatically. Set the key moments by hand.') + (fromAuto ? ' Wrong person? Use Pick hitter.' : '');
    $('pAnalyze').classList.add('done');
  }

  function recompute(redetect) {
    if (!state.hitterIdx) return;
    const raw = state.hitterIdx.map((pi, f) => (pi >= 0 && state.frames[f] ? state.frames[f].poses[pi] : null));
    state.hp = VBA.interpolateGaps(raw, Math.max(2, Math.round(0.15 * state.fps)));
    if (redetect) {
      const ev = VBA.detectEvents(state.hp, state.S, state.fps);
      state.auto = ev;
      for (const k of ['takeoff', 'contact', 'landing']) if (!state.eventsManual[k]) state.events[k] = ev[k];
      state.events.takeoffT = ev.takeoffT; state.events.landingT = ev.landingT; state.events.side = ev.side;
      // size the ball marker from the player's body
      if (!state.ballRUser) {
        const bh = VBA.median(state.hp.map((p) => (p ? VBA.bodyHeightPx(p) : null)));
        if (bh) setBallR(Math.round(clamp(0.058 * bh, 4, 60)));
      }
    }
    refineContactFromBall();
    computeAndRender();
  }

  function refineContactFromBall() {
    if (!state.auto || state.eventsManual.contact || !isNum(state.auto.contact) || !state.hp) return;
    const c = VBA.refineContactWithBall(state.hp, state.events.side, state.auto.contact, state.ball, Math.max(1, Math.round(0.05 * state.fps)));
    state.events.contact = c;
  }

  function ensureSide() {
    if (state.events.side || !isNum(state.events.contact)) return;
    const p = hitterPose(state.events.contact);
    if (p) state.events.side = p.lm[VBA.LM.LWR][1] < p.lm[VBA.LM.RWR][1] ? 'L' : 'R';
  }

  function metricSettings() {
    return { heightM: settings.heightCm ? settings.heightCm / 100 : null, reachM: settings.reachCm ? settings.reachCm / 100 : null, camera: settings.camera };
  }
  function computeAndRender() {
    if (state.hp) {
      ensureSide();
      state.metrics = VBA.computeMetrics({ hp: state.hp, S: state.S, fps: state.fps, events: state.events, settings: metricSettings(),
        ballPts: state.ball, calib: settings.scale === 'line' ? Object.assign({}, state.calib, { meters: lineLenM() }) : null });
    } else state.metrics = null;
    renderAll();
  }

  $('modelInput').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    state.modelBuffer = new Uint8Array(await f.arrayBuffer());
    e.target.value = '';
    toast('Model file loaded. Press Analyze video.');
    $('analyzeStatus').className = 'status'; $('analyzeStatus').textContent = 'Using model file ' + f.name + '.';
  };
  $('modelSel').onchange = (e) => { settings.model = e.target.value; saveSettings(); };

  // =====================================================================
  // Key moments
  // =====================================================================
  function setEvent(key, f) {
    if (!state.videoReady) return;
    state.events[key] = f;
    state.eventsManual[key] = true;
    if (key === 'contact') { state.events.side = null; ensureSide(); }
    computeAndRender();
  }
  function renderEventsUI() {
    const box = $('events');
    box.innerHTML = EVENTS.map((e) => {
      const f = state.events[e.key];
      const has = isNum(f);
      const tag = has ? (state.eventsManual[e.key] ? 'you' : 'auto') : (e.optional ? 'optional' : '');
      return `<div class="ev"><span class="dot" style="background:${e.color}"></span>
        <span class="name">${e.name}<small>${e.hot}</small><span class="fr">${has ? 'frame ' + f + ' · ' + fmtTime(f) : 'not set'}${tag ? ' · ' + tag : ''}</span></span>
        <button class="btn small" data-go="${e.key}" ${has ? '' : 'disabled'}>Go</button>
        <button class="btn small" data-set="${e.key}" ${state.videoReady ? '' : 'disabled'}>Set here</button></div>`;
    }).join('');
    box.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { stopPlayback(); requestFrame(state.events[b.dataset.go]); }));
    box.querySelectorAll('[data-set]').forEach((b) => (b.onclick = () => setEvent(b.dataset.set, state.frame)));
  }
  $('btnRedetect').onclick = () => { state.eventsManual = {}; recompute(true); toast('Key moments re-detected.'); };

  // =====================================================================
  // Ball
  // =====================================================================
  function setBallR(r) { state.ballR = r; $('ballSize').value = r; $('ballSizeVal').textContent = r + ' px'; }
  $('ballSize').oninput = (e) => { state.ballRUser = true; setBallR(parseInt(e.target.value, 10)); render(); };
  function ballChanged() {
    refineContactFromBall();
    computeAndRender();
  }
  $('btnBallClear').onclick = () => { state.ball = {}; ballChanged(); };
  $('btnTrackFwd').onclick = () => trackBall(1);
  $('btnTrackBack').onclick = () => trackBall(-1);

  async function trackBall(dir) {
    if (!state.videoReady || state.busy) return;
    stopPlayback();
    const start = state.frame;
    if (!state.ball[start]) { toast('First click the ball on this frame (turn on Mark ball).', true); setMode('ball'); return; }
    const k = Math.min(1, 1280 / state.vw);
    const ww = Math.round(state.vw * k), wh = Math.round(state.vh * k);
    const work = document.createElement('canvas'); work.width = ww; work.height = wh;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    sizeSmall();
    const sw = smallCanvas.width, sh = smallCanvas.height, kx = sw / state.vw, ky = sh / state.vh;
    const r = Math.max(3, state.ballR * k);
    busy(true, 'Tracking the ball…', '');
    await seekExact(start);
    wctx.drawImage(video, 0, 0, ww, wh);
    let img = wctx.getImageData(0, 0, ww, wh).data;
    let tpl = VBA.makeTemplate(img, ww, wh, state.ball[start].x * k, state.ball[start].y * k, r);
    sctx.drawImage(work, 0, 0, sw, sh);
    let prevGray = grayFrom(smallCanvas, sctx);
    let cum = [0, 0];
    const hist = [[state.ball[start].x, state.ball[start].y]]; // stabilized (relative to start)
    // seed the motion model with points already marked just before the start frame
    if (state.S) {
      for (const q of [start - dir, start - 2 * dir]) {
        const bq = state.ball[q];
        if (!bq || !state.S[q]) break;
        hist.unshift([bq.x - (state.S[q][0] - state.S[start][0]), bq.y - (state.S[q][1] - state.S[start][1])]);
      }
    }
    const contact = state.events.contact;
    const maxSteps = Math.round(state.fps * 1.5);
    let tracked = 0, f = start, stopReason = 'end';
    for (let step = 1; step <= maxSteps; step++) {
      if (state.cancel) { stopReason = 'cancel'; break; }
      f = start + dir * step;
      if (f < 0 || f >= state.nFrames) break;
      // the hit changes the ball's path abruptly: don't guess through it
      if (isNum(contact) && ((dir > 0 && start < contact && f > contact) || (dir < 0 && start > contact && f < contact))) { stopReason = 'contact'; break; }
      await seekExact(f);
      wctx.drawImage(video, 0, 0, ww, wh);
      img = wctx.getImageData(0, 0, ww, wh).data;
      sctx.drawImage(work, 0, 0, sw, sh);
      const gray = grayFrom(smallCanvas, sctx);
      // camera movement between visited frames (mask the ball and hitter)
      const last = hist[hist.length - 1];
      const boxes = [{ x0: (last[0] + cum[0]) * kx - 12, x1: (last[0] + cum[0]) * kx + 12, y0: (last[1] + cum[1]) * ky - 12, y1: (last[1] + cum[1]) * ky + 12 }];
      const hpF = hitterPose(f);
      if (hpF) { const bx = VBA.poseBox(hpF); if (bx) boxes.push({ x0: (bx.x0 - 0.2 * bx.w) * kx, x1: (bx.x1 + 0.2 * bx.w) * kx, y0: (bx.y0 - 0.15 * bx.h) * ky, y1: (bx.y1 + 0.1 * bx.h) * ky }); }
      const s = VBA.estimateShift(prevGray, gray, sw, sh, VBA.makeMask(sw, sh, boxes), 16);
      if (s) { cum = [cum[0] + s.dx / kx, cum[1] + s.dy / ky]; }
      prevGray = gray;
      const existing = state.ball[f];
      let pos = null;
      if (existing && existing.manual) pos = [existing.x, existing.y];
      else {
        const predS = VBA.predictBall(hist.slice(-3));
        const pred = [(predS[0] + cum[0]) * k, (predS[1] + cum[1]) * k];
        const speed = hist.length >= 2 ? Math.hypot(last[0] - hist[hist.length - 2][0], last[1] - hist[hist.length - 2][1]) * k : 0;
        const searchR = clamp(Math.max(3 * r, 0.8 * speed + 2.5 * r), 3 * r, 260 * k + 3 * r);
        const found = VBA.findBall(img, ww, wh, tpl, pred, searchR);
        if (!found || found.score < 0.6) { stopReason = 'lost'; break; }
        if (hist.length >= 3) {
          const dev = Math.hypot(found.x - pred[0], found.y - pred[1]) / k;
          if (dev > Math.max(2 * state.ballR, 0.5 * speed / k + state.ballR) && found.score < 0.85) { stopReason = 'lost'; break; }
        }
        pos = [found.x / k, found.y / k];
        state.ball[f] = { x: pos[0], y: pos[1], auto: true, score: +found.score.toFixed(2) };
        if (found.score > 0.6) tpl = VBA.blendTemplate(tpl, VBA.makeTemplate(img, ww, wh, found.x, found.y, tpl.r), 0.3);
      }
      hist.push([pos[0] - cum[0], pos[1] - cum[1]]);
      tracked++;
      state.frame = f; render(); updateReadout();
      progress(step / maxSteps, `${tracked} frames tracked`);
    }
    busy(false);
    const nTxt = `${tracked} frame${tracked === 1 ? '' : 's'}`;
    const msg = !tracked
      ? (stopReason === 'contact' ? 'This is the contact frame. Click the ball by hand in the next 2–3 frames, then track from there.' : 'Couldn\'t follow the ball from here (too blurry or hidden). Click it by hand in a few frames.')
      : stopReason === 'contact' ? `Ball tracked through ${nTxt}, up to contact. For ball speed, click the ball by hand in 2–3 frames after contact.`
      : stopReason === 'lost' ? `Ball tracked through ${nTxt}, then lost (blur or hidden). Check it, and click by hand where needed.`
      : `Ball tracked through ${nTxt}. Check it, and click to fix any miss.`;
    toast(msg, !tracked, 6500);
    state.frame = start; requestFrame(start);
    ballChanged();
  }

  // =====================================================================
  // Player & camera / scale
  // =====================================================================
  function lineLenM() { return settings.lineLen === 'custom' ? (parseFloat(settings.customLen) || 1) : parseFloat(settings.lineLen); }
  function syncSetupInputs() {
    const imp = settings.units === 'imperial';
    $('lblHeight').textContent = imp ? 'Player height (in)' : 'Player height (cm)';
    $('lblReach').textContent = imp ? 'Standing reach (in)' : 'Standing reach (cm)';
    $('inHeight').value = settings.heightCm ? (imp ? (settings.heightCm / 2.54).toFixed(1) : Math.round(settings.heightCm)) : '';
    $('inReach').value = settings.reachCm ? (imp ? (settings.reachCm / 2.54).toFixed(1) : Math.round(settings.reachCm)) : '';
    $('cameraSel').value = settings.camera; $('unitsSel').value = settings.units; $('scaleSel').value = settings.scale;
    $('lineSel').value = settings.lineLen; $('inLineLen').value = settings.customLen;
    $('modelSel').value = settings.model;
    $('lineRow').hidden = settings.scale !== 'line';
    $('customLenWrap').hidden = settings.lineLen !== 'custom';
  }
  const readLen = (v) => { const x = parseFloat(v); if (!isNum(x) || x <= 0) return null; return settings.units === 'imperial' ? x * 2.54 : x; };
  $('inHeight').onchange = (e) => { settings.heightCm = readLen(e.target.value); saveSettings(); computeAndRender(); };
  $('inReach').onchange = (e) => { settings.reachCm = readLen(e.target.value); saveSettings(); computeAndRender(); };
  $('cameraSel').onchange = (e) => { settings.camera = e.target.value; saveSettings(); computeAndRender(); };
  $('unitsSel').onchange = (e) => { settings.units = e.target.value; saveSettings(); syncSetupInputs(); renderAll(); };
  $('scaleSel').onchange = (e) => { settings.scale = e.target.value; saveSettings(); syncSetupInputs(); computeAndRender(); };
  $('lineSel').onchange = (e) => { settings.lineLen = e.target.value; saveSettings(); syncSetupInputs(); computeAndRender(); };
  $('inLineLen').onchange = (e) => { settings.customLen = parseFloat(e.target.value) || 1; saveSettings(); computeAndRender(); };

  function renderScaleStatus() {
    const st = $('scaleStatus');
    const sc = state.metrics && state.metrics.values._scale;
    if (settings.scale === 'line' && !(state.calib && state.calib.p2)) { st.className = 'status'; st.textContent = 'Press Draw line and click both ends of the reference.'; return; }
    if (sc && sc.pxPerM) { st.className = 'status ok'; st.textContent = `Scale: ${Math.round(sc.pxPerM)} px per metre (from ${sc.source}).`; return; }
    st.className = 'status';
    st.textContent = settings.scale === 'body' ? 'Scale is measured from the hitter\'s body after analysis. Enter the real height for accuracy.' : '';
  }

  // =====================================================================
  // Results panel
  // =====================================================================
  const GROUPS = [
    { title: 'Jump', keys: ['flightTime', 'riseAtContact', 'contactHeight'] },
    { title: 'Arm & body', keys: ['elbowAtContact', 'shoulderAtContact', 'handSpeed', 'plantKnee', 'landingKnee', 'landingGap'] },
    { title: 'Ball', keys: ['ballAngle'] },
    { title: 'Approach', keys: ['approachTime', 'approachSpeed'] },
  ];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderResults() {
    const box = $('results');
    const m = state.metrics && state.metrics.values;
    if (!m) { box.innerHTML = '<div class="empty-state">Results appear here after you analyze a video.</div>'; return; }
    const heroCard = (key, title) => {
      const v = fmtValue(key, m[key]);
      const tip = m[key] ? (m[key].how || m[key].reason || '') : '';
      return `<div class="card" title="${esc(tip)}"><div class="label">${title}</div>${v ? `<div class="value">${v.n}<small>${v.u}</small></div>` : '<div class="value na">-</div>'}</div>`;
    };
    let html = `<div class="hero">${heroCard('jumpHeight', 'Jump height')}${heroCard('contactTiming', 'Contact timing')}${heroCard('ballSpeed', 'Ball speed')}</div>`;
    const ballNA = m.ballSpeed && m.ballSpeed.quality === 'na' ? `<div class="hint" style="margin-top:6px">${esc(m.ballSpeed.reason)}</div>` : '';
    html += ballNA;
    for (const g of GROUPS) {
      const rows = g.keys.filter((k) => m[k]).map((k) => {
        const it = m[k], v = fmtValue(k, it);
        const q = it.quality === 'good' ? '<span class="badge good">Good</span>' : it.quality === 'estimate' ? '<span class="badge estimate">Estimate</span>' : '<span class="badge na">n/a</span>';
        return `<div class="metric"><span class="m-label">${esc(it.label)}<span class="info" title="${esc(it.how || it.reason || '')}">i</span></span>
          ${v ? `<span class="m-val">${v.n} ${v.u}</span>` : `<span class="m-val na" title="${esc(it.reason || '')}">${esc(shortReason(it.reason))}</span>`}${q}</div>`;
      }).join('');
      if (rows) html += `<div class="metric-group"><h4>${g.title}</h4>${rows}</div>`;
    }
    const notes = state.metrics.notes || [];
    if (notes.length) html += `<div class="metric-group"><h4>Quick notes</h4><ul class="notes">${notes.map((n) => `<li class="${n.tone}">${esc(n.text)}</li>`).join('')}</ul><div class="hint" style="margin-top:6px">Rules of thumb from the numbers above, not a substitute for a coach's eye.</div></div>`;
    if (state.fps < 100) html += `<div class="hint" style="margin-top:4px">Recorded at ${fmtFps(state.fps)} fps: timings are ±${Math.round(500 / state.fps)} ms. Slow-mo (120/240 fps) gives much tighter numbers.</div>`;
    box.innerHTML = html;
  }
  function shortReason(r) {
    if (!r) return 'n/a';
    if (/reach/i.test(r)) return 'needs reach';
    if (/tripod/i.test(r)) return 'needs tripod';
    if (/scale/i.test(r)) return 'needs scale';
    if (/ball/i.test(r)) return 'mark ball';
    return 'n/a';
  }

  // =====================================================================
  // Charts (canvas, no libraries)
  // =====================================================================
  const charts = { H: { canvas: $('chartH'), hover: null }, A: { canvas: $('chartA'), hover: null } };
  function chartSeries() {
    if (!state.hp) return null;
    const hp = state.hp, S = state.S, n = state.nFrames, ev = state.events;
    const sc = state.metrics && state.metrics.values._scale;
    const pxPerM = sc && sc.pxPerM;
    const sig = VBA.hitterSignals(hp, S);
    let f0 = null, f1 = null;
    for (let f = 0; f < n; f++) if (hp[f]) { if (f0 == null) f0 = f; f1 = f; }
    if (f0 == null) return null;
    let ground = null;
    if (isNum(ev.takeoff)) ground = VBA.median(sig.feet.slice(Math.max(0, ev.takeoff - 3), ev.takeoff));
    if (ground == null) ground = Math.max(...sig.feet.filter(isNum));
    const side = ev.side || 'R';
    const wr = side === 'L' ? sig.wrL : sig.wrR;
    const unitH = pxPerM ? pxPerM : (VBA.median(sig.bh) || 300) / 1.75;
    const hip = [], hand = [], knee = [], elbow = [];
    for (let f = f0; f <= f1; f++) {
      const p = hp[f];
      hip.push(p && isNum(sig.hip[f]) ? (ground - sig.hip[f]) / unitH : null);
      hand.push(p && isNum(wr[f]) ? (ground - wr[f]) / unitH : null);
      if (p) {
        const kl = VBA.kneeAngle(p, 'L'), kr = VBA.kneeAngle(p, 'R');
        knee.push(isNum(kl) && isNum(kr) ? Math.min(kl, kr) : (isNum(kl) ? kl : kr));
        elbow.push(VBA.elbowAngle(p, side));
      } else { knee.push(null); elbow.push(null); }
    }
    return { f0, f1, H: [{ name: 'Hip', color: C.s1, vals: hip }, { name: 'Hitting hand', color: C.s2, vals: hand }],
      A: [{ name: 'Knee (more bent leg)', color: C.s1, vals: knee }, { name: 'Hitting elbow', color: C.s2, vals: elbow }] };
  }
  function legend(el, series) { el.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join(''); }

  function niceStep(range, target) {
    const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }
  function drawCharts() {
    const data = state.videoReady ? chartSeries() : null;
    $('charts').classList.toggle('empty', !data);
    for (const key of ['H', 'A']) {
      const ch = charts[key], c = ch.canvas, ctx = c.getContext('2d');
      const dpr = syncCanvas(c);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
      const font = getComputedStyle(document.body).fontFamily;
      if (!data) {
        ctx.fillStyle = C.axis; ctx.font = `${12 * dpr}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('Analyze a video to see this chart', c.width / 2, c.height / 2);
        ch.geom = null; continue;
      }
      const series = data[key];
      legend($(key === 'H' ? 'legendH' : 'legendA'), series);
      const L = 38 * dpr, R = 10 * dpr, Tp = 8 * dpr, B = 20 * dpr;
      const W = c.width - L - R, H = c.height - Tp - B;
      const { f0, f1 } = data;
      const xOf = (f) => L + (f1 === f0 ? 0 : (f - f0) / (f1 - f0)) * W;
      let mn = Infinity, mx = -Infinity;
      series.forEach((s) => s.vals.forEach((v) => { if (isNum(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }));
      if (!isFinite(mn)) { mn = 0; mx = 1; }
      if (key === 'A') { mn = Math.min(mn, 60); mx = Math.max(mx, 180); }
      if (key === 'H') { mn = Math.min(mn, 0); }
      const pad = (mx - mn) * 0.08 || 1; mn -= pad; mx += pad;
      const yOf = (v) => Tp + H - (v - mn) / (mx - mn) * H;
      // grid + y labels
      const ys = niceStep(mx - mn, 4);
      ctx.font = `${10.5 * dpr}px ${font}`; ctx.fillStyle = C.axis; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1 * dpr;
      for (let v = Math.ceil(mn / ys) * ys; v <= mx; v += ys) {
        const y = Math.round(yOf(v)) + 0.5; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + W, y); ctx.stroke();
        ctx.fillText((key === 'H' ? +v.toFixed(2) : Math.round(v)) + '', L - 6 * dpr, y);
      }
      // x labels: seconds relative to take-off (or absolute)
      const ref = isNum(state.events.takeoff) ? state.events.takeoff : 0;
      const t0 = (f0 - ref) / state.fps, t1 = (f1 - ref) / state.fps, xs = niceStep(t1 - t0 || 1, 6);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let t = Math.ceil(t0 / xs) * xs; t <= t1 + 1e-9; t += xs) {
        const x = xOf(ref + t * state.fps);
        ctx.fillText((Math.abs(t) < 1e-9 ? '0' : (t > 0 ? '+' : '') + t.toFixed(xs < 0.1 ? 2 : 1)) + ' s', x, Tp + H + 5 * dpr);
      }
      // event lines
      ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.lineWidth = 1 * dpr;
      for (const e of EVENTS) {
        const f = state.events[e.key]; if (!isNum(f) || f < f0 || f > f1) continue;
        const x = Math.round(xOf(f)) + 0.5;
        ctx.strokeStyle = '#55545a'; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + H); ctx.stroke();
        ctx.fillStyle = C.text2; ctx.font = `600 ${10 * dpr}px ${font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(e.hot, x + 3 * dpr, Tp + 1 * dpr);
      }
      ctx.setLineDash([]);
      // lines
      for (const s of series) {
        ctx.strokeStyle = s.color; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round';
        ctx.beginPath(); let pen = false;
        s.vals.forEach((v, i) => { if (!isNum(v)) { pen = false; return; } const x = xOf(f0 + i), y = yOf(v); if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; } });
        ctx.stroke();
      }
      // playhead
      if (state.frame >= f0 && state.frame <= f1) {
        const x = Math.round(xOf(state.frame)) + 0.5;
        ctx.strokeStyle = 'rgba(236,235,231,0.85)'; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + H); ctx.stroke();
      }
      // hover tooltip
      const hf = ch.hover;
      if (isNum(hf) && hf >= f0 && hf <= f1) {
        const x = xOf(hf);
        ctx.strokeStyle = 'rgba(236,235,231,0.35)'; ctx.beginPath(); ctx.moveTo(x, Tp); ctx.lineTo(x, Tp + H); ctx.stroke();
        const lines = [`f ${hf} · ${((hf - ref) / state.fps >= 0 ? '+' : '')}${((hf - ref) / state.fps).toFixed(2)} s`];
        series.forEach((s) => { const v = s.vals[hf - f0]; lines.push([s, isNum(v) ? (key === 'H' ? v.toFixed(2) + ' m' : Math.round(v) + '°') : '-']); });
        series.forEach((s) => { const v = s.vals[hf - f0]; if (isNum(v)) { ctx.fillStyle = s.color; ctx.strokeStyle = C.panel; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(x, yOf(v), 4 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } });
        ctx.font = `${11 * dpr}px ${font}`;
        const tw = Math.max(...lines.map((l) => ctx.measureText(typeof l === 'string' ? l : l[0].name + '  ' + l[1]).width)) + 26 * dpr;
        const th = lines.length * 15 * dpr + 8 * dpr;
        let bx = x + 10 * dpr; if (bx + tw > c.width - 4 * dpr) bx = x - 10 * dpr - tw;
        ctx.fillStyle = 'rgba(23,24,27,0.95)'; ctx.strokeStyle = '#3a3d44'; ctx.lineWidth = 1 * dpr;
        roundRect(ctx, bx, Tp + 4 * dpr, tw, th, 6 * dpr); ctx.fill(); ctx.stroke();
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        lines.forEach((l, i) => {
          const y = Tp + 8 * dpr + i * 15 * dpr;
          if (typeof l === 'string') { ctx.fillStyle = C.text2; ctx.fillText(l, bx + 8 * dpr, y); }
          else { ctx.fillStyle = l[0].color; ctx.fillRect(bx + 8 * dpr, y + 5 * dpr, 10 * dpr, 3 * dpr); ctx.fillStyle = C.text; ctx.fillText(l[0].name + '  ' + l[1], bx + 22 * dpr, y); }
        });
      }
      ch.geom = { f0, f1, L, W, dpr };
    }
  }
  for (const key of ['H', 'A']) {
    const ch = charts[key], c = ch.canvas;
    const fAt = (e) => { if (!ch.geom) return null; const r = c.getBoundingClientRect(); const x = (e.clientX - r.left) * ch.geom.dpr; const t = clamp((x - ch.geom.L) / ch.geom.W, 0, 1); return Math.round(ch.geom.f0 + t * (ch.geom.f1 - ch.geom.f0)); };
    c.addEventListener('mousemove', (e) => { ch.hover = fAt(e); drawCharts(); });
    c.addEventListener('mouseleave', () => { ch.hover = null; drawCharts(); });
    c.addEventListener('click', (e) => { const f = fAt(e); if (isNum(f)) { stopPlayback(); requestFrame(f); } });
  }

  // =====================================================================
  // Timeline
  // =====================================================================
  const tl = $('timeline');
  function drawTimeline() {
    const dpr = syncCanvas(tl), ctx = tl.getContext('2d'), W = tl.width, H = tl.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    if (!state.videoReady) return;
    const P = 10 * dpr, n = state.nFrames;
    const xOf = (f) => P + (n > 1 ? f / (n - 1) : 0) * (W - 2 * P);
    const font = getComputedStyle(document.body).fontFamily;
    const midY = H * 0.62;
    // track
    ctx.fillStyle = '#26282d'; roundRect(ctx, P, midY - 4 * dpr, W - 2 * P, 8 * dpr, 4 * dpr); ctx.fill();
    if (state.range) { ctx.fillStyle = '#3a3d44'; roundRect(ctx, xOf(state.range[0]), midY - 4 * dpr, Math.max(2, xOf(state.range[1]) - xOf(state.range[0])), 8 * dpr, 4 * dpr); ctx.fill(); }
    if (state.hitterIdx) {
      ctx.fillStyle = 'rgba(255,200,61,0.55)';
      state.hitterIdx.forEach((pi, f) => { if (pi >= 0) ctx.fillRect(xOf(f) - 0.5 * dpr, midY + 6 * dpr, Math.max(1, (W - 2 * P) / n + 0.5), 2 * dpr); });
    }
    ctx.fillStyle = C.ball;
    for (const f of Object.keys(state.ball)) ctx.fillRect(xOf(+f) - 1 * dpr, midY - 9 * dpr, 2 * dpr, 4 * dpr);
    // events
    ctx.font = `700 ${10 * dpr}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const e of EVENTS) {
      const f = state.events[e.key]; if (!isNum(f)) continue;
      const x = xOf(f);
      ctx.fillStyle = e.hex; ctx.fillRect(x - 1 * dpr, midY - 6 * dpr, 2 * dpr, 12 * dpr);
      ctx.beginPath(); ctx.arc(x, 10 * dpr, 8 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111'; ctx.fillText(e.hot, x, 10.5 * dpr);
    }
    // playhead
    const x = xOf(state.frame);
    ctx.fillStyle = C.text; ctx.fillRect(x - 1 * dpr, midY - 10 * dpr, 2 * dpr, 20 * dpr);
    ctx.beginPath(); ctx.arc(x, midY, 5 * dpr, 0, Math.PI * 2); ctx.fill();
    tl._x = { P, W, n, dpr };
  }
  let tlDrag = false;
  const tlFrame = (e) => { const g = tl._x; if (!g) return 0; const r = tl.getBoundingClientRect(); return Math.round(clamp(((e.clientX - r.left) * g.dpr - g.P) / (g.W - 2 * g.P), 0, 1) * (g.n - 1)); };
  tl.addEventListener('pointerdown', (e) => { if (!state.videoReady || state.busy) return; tlDrag = true; tl.setPointerCapture(e.pointerId); stopPlayback(); requestFrame(tlFrame(e)); });
  tl.addEventListener('pointermove', (e) => { if (tlDrag) requestFrame(tlFrame(e)); });
  tl.addEventListener('pointerup', () => { tlDrag = false; });

  // =====================================================================
  // Save / load / export
  // =====================================================================
  function baseName() { return state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'analysis'; }
  async function saveBlob(name, blob, desc, accept) {
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept }] });
        const w = await h.createWritable(); await w.write(blob); await w.close();
        toast('Saved ' + h.name); return;
      } catch (e) { if (e && e.name === 'AbortError') return; console.warn('save picker failed, downloading instead', e); }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Saved to your Downloads folder as ' + name);
  }
  const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000, r2 = (v) => Math.round(v * 100) / 100;
  function serialize() {
    return {
      app: 'volleyball-hitting-analyzer', version: 1, savedAt: new Date().toISOString(),
      video: { name: state.file && state.file.name, size: state.file && state.file.size, duration: state.duration, width: state.vw, height: state.vh },
      fps: state.fps, range: state.range, settings,
      events: state.events, eventsManual: state.eventsManual, ball: state.ball, ballR: state.ballR, calib: state.calib,
      hitterIdx: state.hitterIdx, shifts: state.shifts && state.shifts.map((s) => (s ? [r2(s[0]), r2(s[1])] : null)),
      frames: state.frames && state.frames.map((fr) => (fr ? { poses: fr.poses.map((p) => ({ lm: p.lm.map((q) => [r1(q[0]), r1(q[1]), r2(q[2])]), w: p.w ? p.w.map((q) => q.map(r3)) : null })) } : null)),
      metrics: state.metrics && state.metrics.values,
    };
  }
  $('btnSave').onclick = () => {
    const blob = new Blob([JSON.stringify(serialize())], { type: 'application/json' });
    saveBlob(baseName() + '_analysis.json', blob, 'Analysis file', { 'application/json': ['.json'] });
  };
  $('btnLoad').onclick = () => $('analysisInput').click();
  $('analysisInput').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (err) { toast('That file isn\'t a valid analysis.', true); return; }
    if (data.app !== 'volleyball-hitting-analyzer') { toast('That file isn\'t an analysis from this app.', true); return; }
    if (!state.videoReady || (data.video && state.file && data.video.name !== state.file.name)) {
      state.pendingAnalysis = data;
      toast(`Now open the video "${data.video && data.video.name}". The analysis will attach to it.`, false, 8000);
      $('analyzeStatus').textContent = `Waiting for video "${data.video && data.video.name}"…`;
      return;
    }
    applyAnalysis(data);
  };
  function applyAnalysis(data) {
    state.pendingAnalysis = null;
    Object.assign(settings, data.settings || {}); saveSettings(); syncSetupInputs();
    if (data.fps && data.fps !== state.fps) setFps(data.fps, true);
    state.frames = data.frames; state.shifts = data.shifts || new Array(state.nFrames).fill(null); state.range = data.range;
    state.S = VBA.cumulativeShift(state.shifts, state.nFrames);
    state.hitterIdx = data.hitterIdx; state.events = data.events || {}; state.eventsManual = data.eventsManual || {};
    state.ball = data.ball || {}; state.calib = data.calib || null; state.analyzed = !!data.frames;
    if (data.ballR) { state.ballRUser = true; setBallR(data.ballR); }
    if (state.hitterIdx) {
      const raw = state.hitterIdx.map((pi, f) => (pi >= 0 && state.frames[f] ? state.frames[f].poses[pi] : null));
      state.hp = VBA.interpolateGaps(raw, Math.max(2, Math.round(0.15 * state.fps)));
      state.auto = VBA.detectEvents(state.hp, state.S, state.fps);
    }
    $('pAnalyze').classList.toggle('done', !!state.hitterIdx);
    $('analyzeStatus').className = 'status ok'; $('analyzeStatus').textContent = 'Saved analysis loaded.';
    computeAndRender();
    toast('Analysis loaded.');
  }

  $('btnCsv').onclick = () => {
    const rows = [['Metric', 'Value', 'Unit', 'Quality', 'How it is measured']];
    const m = (state.metrics && state.metrics.values) || {};
    for (const [k, it] of Object.entries(m)) {
      if (k.startsWith('_')) continue;
      const v = fmtValue(k, it);
      rows.push([it.label, v ? v.n : '', v ? v.u : '', it.quality, it.how || it.reason || '']);
    }
    rows.push([]);
    rows.push(['Key moment', 'Frame', 'Time (s)']);
    for (const e of EVENTS) if (isNum(state.events[e.key])) rows.push([e.name, state.events[e.key], (state.events[e.key] / state.fps).toFixed(3)]);
    rows.push([]);
    const data = chartSeries();
    rows.push(['Frame', 'Time (s)', 'Hip height (m)', 'Hitting hand height (m)', 'Knee angle (deg)', 'Hitting elbow angle (deg)', 'Ball x (px)', 'Ball y (px)']);
    for (let f = 0; f < state.nFrames; f++) {
      const i = data ? f - data.f0 : -1;
      const g = (arr, d) => (data && i >= 0 && i < arr.length && isNum(arr[i]) ? arr[i].toFixed(d) : '');
      const b = state.ball[f];
      if (!(data && i >= 0 && i <= data.f1 - data.f0) && !b) continue;
      rows.push([f, (f / state.fps).toFixed(3), data ? g(data.H[0].vals, 3) : '', data ? g(data.H[1].vals, 3) : '', data ? g(data.A[0].vals, 1) : '', data ? g(data.A[1].vals, 1) : '', b ? b.x.toFixed(1) : '', b ? b.y.toFixed(1) : '']);
    }
    const csv = rows.map((r) => r.map((c) => { const s = String(c == null ? '' : c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    saveBlob(baseName() + '_metrics.csv', new Blob(['﻿' + csv], { type: 'text/csv' }), 'CSV file', { 'text/csv': ['.csv'] });
  };

  $('btnSnap').onclick = () => {
    if (!state.videoReady) return;
    const c = document.createElement('canvas'); c.width = state.vw; c.height = state.vh;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0);
    drawOverlays(ctx, { s: 1, ox: 0, oy: 0 }, state.frame, state.vh / 540);
    c.toBlob((blob) => saveBlob(`${baseName()}_frame${state.frame}.png`, blob, 'PNG image', { 'image/png': ['.png'] }), 'image/png');
  };

  // =====================================================================
  // Open / drag-drop / keyboard
  // =====================================================================
  $('btnOpen').onclick = () => $('videoInput').click();
  $('videoInput').onchange = (e) => { openVideo(e.target.files[0]); e.target.value = ''; };
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault(); stage.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) { const dt = new DataTransfer(); dt.items.add(f); $('analysisInput').files = dt.files; $('analysisInput').onchange({ target: $('analysisInput') }); }
    else openVideo(f);
  });

  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.videoReady || state.busy) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); state.playing ? stopPlayback() : play(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stopPlayback(); requestFrame(state.frame - (e.shiftKey ? 10 : 1)); }
    else if (k === 'ArrowRight') { e.preventDefault(); stopPlayback(); requestFrame(state.frame + (e.shiftKey ? 10 : 1)); }
    else if (k === 'Home') { stopPlayback(); requestFrame(0); }
    else if (k === 'End') { stopPlayback(); requestFrame(state.nFrames - 1); }
    else if (k === 'Escape') setMode(null);
    else if (k === 'b' || k === 'B') setMode('ball');
    else if (k === 'Delete' || k === 'Backspace') { if (state.ball[state.frame]) { delete state.ball[state.frame]; ballChanged(); } }
    else { const ev = EVENTS.find((x) => x.hot === k.toUpperCase()); if (ev) setEvent(ev.key, state.frame); }
  });

  // =====================================================================
  // Global refresh
  // =====================================================================
  function updateButtons() {
    const ready = state.videoReady && !state.busy;
    $('btnAnalyze').disabled = !ready;
    $('btnAnalyze').textContent = state.analyzed ? 'Analyze again' : 'Analyze video';
    $('btnPick').disabled = !ready || !state.analyzed;
    $('btnRedetect').disabled = !ready || !state.hp;
    $('btnBallMode').disabled = !ready;
    $('btnTrackFwd').disabled = $('btnTrackBack').disabled = !ready || !state.ball[state.frame];
    $('btnBallClear').disabled = !ready || !Object.keys(state.ball).length;
    $('btnDrawLine').disabled = !ready;
    $('btnSave').disabled = !state.videoReady || !state.analyzed;
    $('btnCsv').disabled = !state.metrics;
    $('btnSnap').disabled = !state.videoReady;
    const nb = Object.keys(state.ball).length;
    $('ballStatus').textContent = nb ? `${nb} ball point${nb > 1 ? 's' : ''}${state.ball[state.frame] ? ' · one on this frame' : ''}.` : 'No ball points yet.';
  }
  function renderAll() {
    render(); updateReadout(); renderEventsUI(); renderResults(); renderScaleStatus(); drawTimeline(); drawCharts(); updateButtons();
  }
  // keep frame-dependent buttons fresh while stepping
  const _req = requestFrame;
  requestFrame = function (f) { _req(f); updateButtons(); }; // eslint-disable-line no-func-assign
  window.addEventListener('resize', () => { render(); drawTimeline(); drawCharts(); });
  for (const id of ['tSkel', 'tAngles', 'tOthers', 'tBall']) $(id).addEventListener('change', render);

  syncSetupInputs();
  renderAll();

  // test hook (used only by automated tests)
  window.__vb = { state, settings, analyze, trackBall, setEvent, requestFrame: (f) => requestFrame(f), seekExact, openVideo, setMode, handleClick, recompute, computeAndRender, serialize, applyAnalysis };
})();
