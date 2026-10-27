/*
 * Volleyball Hitting Analyzer - analysis engine
 * Pure functions only (no DOM), so they can be tested outside the browser.
 *
 * Coordinate conventions
 *   - Image landmarks are in full-resolution video pixels, y pointing DOWN.
 *   - "Stabilized" coordinates subtract the cumulative camera shift S[f], so a
 *     point on the background stays put even when the phone pans/tilts.
 *   - World landmarks come from MediaPipe: metres, origin between the hips.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VBA = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = 9.81;
  const LM = {
    NOSE: 0, LSH: 11, RSH: 12, LEL: 13, REL: 14, LWR: 15, RWR: 16,
    LHIP: 23, RHIP: 24, LKN: 25, RKN: 26, LANK: 27, RANK: 28,
    LHEEL: 29, RHEEL: 30, LTOE: 31, RTOE: 32,
  };
  const SIDES = {
    L: { sh: LM.LSH, el: LM.LEL, wr: LM.LWR, hip: LM.LHIP, kn: LM.LKN, an: LM.LANK, heel: LM.LHEEL, toe: LM.LTOE },
    R: { sh: LM.RSH, el: LM.REL, wr: LM.RWR, hip: LM.RHIP, kn: LM.RKN, an: LM.RANK, heel: LM.RHEEL, toe: LM.RTOE },
  };
  // Pose connections for drawing (subset of MediaPipe's 33-point topology)
  const CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
    [15, 19], [16, 20], [0, 11], [0, 12],
  ];
  // Shoulder->ankle chain is ~0.78 of standing height for most adults.
  const CHAIN_TO_HEIGHT = 0.78;
  const VIS = 0.3;

  // ---------- small helpers ----------
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  function median(arr) {
    const a = arr.filter(isNum).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function dist2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

  /** Angle ABC in degrees (3D or 2D points). */
  function angleAt(a, b, c) {
    const u = [a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0)];
    const v = [c[0] - b[0], c[1] - b[1], (c[2] || 0) - (b[2] || 0)];
    const nu = Math.hypot(u[0], u[1], u[2]), nv = Math.hypot(v[0], v[1], v[2]);
    if (!nu || !nv) return null;
    const cos = clamp((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv), -1, 1);
    return Math.acos(cos) * 180 / Math.PI;
  }

  /** Running median with odd window (keeps sharp edges like take-off). */
  function medianFilter(arr, win) {
    if (win <= 1) return arr.slice();
    const h = win >> 1, out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      if (!isNum(arr[i])) { out[i] = null; continue; }
      const w = [];
      for (let k = Math.max(0, i - h); k <= Math.min(arr.length - 1, i + h); k++) if (isNum(arr[k])) w.push(arr[k]);
      out[i] = median(w);
    }
    return out;
  }

  function cumulativeShift(shifts, n) {
    const S = new Array(n);
    let x = 0, y = 0;
    for (let f = 0; f < n; f++) {
      const s = shifts && shifts[f];
      if (f > 0 && s && isNum(s[0]) && isNum(s[1])) { x += s[0]; y += s[1]; }
      S[f] = [x, y];
    }
    return S;
  }

  // ---------- pose geometry ----------
  function pt(pose, i) { return pose && pose.lm[i]; }
  function visible(pose, i, thr) { const p = pt(pose, i); return !!p && (p[2] == null || p[2] >= (thr == null ? VIS : thr)); }

  function poseBox(pose) {
    if (!pose) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (let i = 0; i < pose.lm.length; i++) {
      if (!visible(pose, i, 0.2)) continue;
      const [x, y] = pose.lm[i];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); n++;
    }
    if (n < 5) return null;
    const hips = [pose.lm[LM.LHIP], pose.lm[LM.RHIP]];
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (hips[0][0] + hips[1][0]) / 2, cy: (hips[0][1] + hips[1][1]) / 2 };
  }

  /** Shoulder->hip->knee->ankle length in px (longest side, least foreshortened). */
  function chainPx(pose) {
    let best = null;
    for (const s of [SIDES.L, SIDES.R]) {
      const a = pose.lm[s.sh], b = pose.lm[s.hip], c = pose.lm[s.kn], d = pose.lm[s.an];
      if (!a || !b || !c || !d) continue;
      const len = dist2(a, b) + dist2(b, c) + dist2(c, d);
      if (best == null || len > best) best = len;
    }
    return best;
  }
  function bodyHeightPx(pose) { const c = pose && chainPx(pose); return c ? c / CHAIN_TO_HEIGHT : null; }

  function lowestFootY(pose, side) {
    const sides = side ? [SIDES[side]] : [SIDES.L, SIDES.R];
    let best = null;
    for (const s of sides) {
      for (const i of [s.an, s.heel, s.toe]) {
        if (!visible(pose, i, 0.15)) continue;
        const y = pose.lm[i][1];
        if (best == null || y > best) best = y;
      }
    }
    if (best == null) {
      // fall back to ankles regardless of visibility
      for (const s of sides) { const p = pose.lm[s.an]; if (p && (best == null || p[1] > best)) best = p[1]; }
    }
    return best;
  }
  function hipY(pose) { return (pose.lm[LM.LHIP][1] + pose.lm[LM.RHIP][1]) / 2; }
  function hipX(pose) { return (pose.lm[LM.LHIP][0] + pose.lm[LM.RHIP][0]) / 2; }

  // ---------- multi-person tracking ----------
  /**
   * Link poses frame-to-frame into tracks (greedy nearest neighbour on
   * stabilized hip centre, normalised by body size).
   */
  function buildTracks(frames, S) {
    const tracks = [];
    for (let f = 0; f < frames.length; f++) {
      const poses = (frames[f] && frames[f].poses) || [];
      const boxes = poses.map((p) => {
        const b = poseBox(p);
        return b && Object.assign(b, { sx: b.cx - S[f][0], sy: b.cy - S[f][1] });
      });
      const cands = [];
      tracks.forEach((t, ti) => {
        const gap = f - t.last;
        if (gap > 8) return;
        boxes.forEach((b, pi) => {
          if (!b) return;
          const d = Math.hypot(b.sx - t.sx, b.sy - t.sy) / Math.max(t.h, b.h, 1);
          if (d < 0.45 + 0.08 * gap) cands.push({ ti, pi, d });
        });
      });
      cands.sort((a, b) => a.d - b.d);
      const usedT = new Set(), usedP = new Set();
      for (const c of cands) {
        if (usedT.has(c.ti) || usedP.has(c.pi)) continue;
        usedT.add(c.ti); usedP.add(c.pi);
        const t = tracks[c.ti], b = boxes[c.pi];
        t.map[f] = c.pi; t.last = f; t.sx = b.sx; t.sy = b.sy; t.h = b.h; t.count++;
        t.hs.push(b.h); t.ys.push(b.sy);
      }
      boxes.forEach((b, pi) => {
        if (!b || usedP.has(pi)) return;
        const t = { id: tracks.length, map: {}, first: f, last: f, sx: b.sx, sy: b.sy, h: b.h, count: 1, hs: [b.h], ys: [b.sy] };
        t.map[f] = pi;
        tracks.push(t);
      });
    }
    return tracks;
  }

  /** Score tracks: long-lived, large in frame, and moving vertically (jumping). */
  function pickHitterTrack(tracks, nFrames, videoH) {
    let best = null;
    for (const t of tracks) {
      if (t.count < Math.max(5, 0.1 * nFrames)) continue;
      const h = median(t.hs) || 1;
      const ys = t.ys.slice().sort((a, b) => a - b);
      const range = (ys[Math.floor(ys.length * 0.95)] - ys[Math.floor(ys.length * 0.05)]) / h;
      const score = (t.count / nFrames) * (h / videoH) * (1 + 2 * Math.min(range, 1));
      if (!best || score > best.score) best = { track: t, score };
    }
    return best && best.track;
  }

  /** The pose in frame f closest to (x, y) - used when the user clicks a person. */
  function poseAtPoint(frame, x, y) {
    if (!frame || !frame.poses) return -1;
    let best = -1, bestD = Infinity;
    frame.poses.forEach((p, i) => {
      const b = poseBox(p);
      if (!b) return;
      const inside = x >= b.x0 - 0.15 * b.w && x <= b.x1 + 0.15 * b.w && y >= b.y0 - 0.1 * b.h && y <= b.y1 + 0.1 * b.h;
      const d = Math.hypot(x - (b.x0 + b.x1) / 2, y - (b.y0 + b.y1) / 2) / Math.max(b.h, 1) - (inside ? 10 : 0);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /**
   * Follow one person forwards and backwards from a seed pose.
   * Returns an array with a pose index per frame (-1 = not found).
   */
  function followFromSeed(frames, S, f0, p0) {
    const n = frames.length, idx = new Array(n).fill(-1);
    if (p0 < 0 || !frames[f0] || !frames[f0].poses[p0]) return idx;
    idx[f0] = p0;
    for (const dir of [1, -1]) {
      let lastB = poseBox(frames[f0].poses[p0]), lastF = f0;
      let last = { sx: lastB.cx - S[f0][0], sy: lastB.cy - S[f0][1], h: lastB.h };
      for (let f = f0 + dir; f >= 0 && f < n; f += dir) {
        const gap = Math.abs(f - lastF);
        if (gap > 15) break;
        const poses = (frames[f] && frames[f].poses) || [];
        let best = -1, bestD = Infinity;
        poses.forEach((p, i) => {
          const b = poseBox(p);
          if (!b) return;
          const d = Math.hypot(b.cx - S[f][0] - last.sx, b.cy - S[f][1] - last.sy) / Math.max(last.h, b.h, 1);
          if (d < bestD) { bestD = d; best = i; }
        });
        if (best >= 0 && bestD < 0.5 + 0.08 * gap) {
          idx[f] = best;
          const b = poseBox(poses[best]);
          last = { sx: b.cx - S[f][0], sy: b.cy - S[f][1], h: b.h };
          lastF = f;
        }
      }
    }
    return idx;
  }

  /** Fill short gaps in a per-frame pose list by linear interpolation. */
  function interpolateGaps(list, maxGap) {
    const out = list.slice();
    let i = 0;
    while (i < out.length) {
      if (out[i]) { i++; continue; }
      let j = i;
      while (j < out.length && !out[j]) j++;
      const a = out[i - 1], b = out[j];
      if (a && b && j - i <= maxGap) {
        for (let k = i; k < j; k++) {
          const t = (k - i + 1) / (j - i + 1);
          const lerp = (P, Q) => P.map((p, m) => p.map((v, c) => v + (Q[m][c] - v) * t));
          out[k] = { lm: lerp(a.lm, b.lm), w: a.w && b.w ? lerp(a.w, b.w) : null, interpolated: true };
        }
      }
      i = j;
    }
    return out;
  }

  // ---------- event detection ----------
  /** Per-frame signals for the hitter (stabilized image coordinates). */
  function hitterSignals(hp, S) {
    const n = hp.length;
    const sig = { feet: new Array(n).fill(null), feetL: new Array(n).fill(null), feetR: new Array(n).fill(null),
      hip: new Array(n).fill(null), hipX: new Array(n).fill(null), bh: new Array(n).fill(null),
      wrL: new Array(n).fill(null), wrR: new Array(n).fill(null) };
    for (let f = 0; f < n; f++) {
      const p = hp[f];
      if (!p) continue;
      const sy = S[f][1], sx = S[f][0];
      sig.feet[f] = lowestFootY(p) - sy;
      sig.feetL[f] = lowestFootY(p, 'L') - sy;
      sig.feetR[f] = lowestFootY(p, 'R') - sy;
      sig.hip[f] = hipY(p) - sy;
      sig.hipX[f] = hipX(p) - sx;
      sig.bh[f] = bodyHeightPx(p);
      sig.wrL[f] = p.lm[LM.LWR][1] - sy;
      sig.wrR[f] = p.lm[LM.RWR][1] - sy;
    }
    return sig;
  }

  /** Fractional frame where a straight line fitted to pts [[frame, y], ...] reaches y = target. */
  function crossing(pts, target) {
    if (pts.length < 2) return null;
    const n = pts.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;
    if (Math.abs(b) < 1e-6) return null;
    return (target - a) / b;
  }
  function maxIn(arr, a, b) { let m = null; for (let k = Math.max(0, a); k <= Math.min(arr.length - 1, b); k++) if (isNum(arr[k]) && (m == null || arr[k] > m)) m = arr[k]; return m; }

  /**
   * Detect take-off, contact and landing.
   *   takeoff = first frame with both feet off the ground
   *   landing = first frame a foot is back on the ground
   *   contact = frame where the hitting hand is highest during the flight
   */
  function detectEvents(hp, S, fps) {
    const n = hp.length;
    const sig = hitterSignals(hp, S);
    const win = Math.max(3, 2 * Math.round(fps / 60) + 1);
    const feet = medianFilter(sig.feet, win);
    const hip = medianFilter(sig.hip, win);
    const BH = median(sig.bh) || 300;
    const res = { takeoff: null, landing: null, contact: null, peak: null, side: null, confidence: 'low', sig };

    // 1) Peak = most prominent "highest hip" moment.
    const wP = Math.round(0.7 * fps), wL = Math.max(1, Math.round(0.12 * fps));
    let best = null;
    for (let f = 0; f < n; f++) {
      if (!isNum(hip[f])) continue;
      let isMin = true;
      for (let k = Math.max(0, f - wL); k <= Math.min(n - 1, f + wL); k++) if (isNum(hip[k]) && hip[k] < hip[f]) { isMin = false; break; }
      if (!isMin) continue;
      const left = maxIn(hip, f - wP, f), right = maxIn(hip, f, f + wP);
      if (left == null || right == null) continue;
      const prom = Math.min(left, right) - hip[f];
      if (!best || prom > best.prom) best = { f, prom };
    }
    if (!best || best.prom < 0.08 * BH) return res;
    const peak = best.f;
    res.peak = peak;
    const bhLocal = median(sig.bh.slice(Math.max(0, peak - wP), peak + wP + 1)) || BH;
    const thr = Math.max(2, 0.04 * bhLocal);
    const thrSmall = Math.max(1.5, 0.012 * bhLocal);
    const d = Math.max(1, Math.round(fps / 30));
    const vthr = 0.35 * bhLocal / fps * d; // px moved over d frames that counts as "moving"
    const up = (k) => (isNum(feet[k - d]) && isNum(feet[k])) ? feet[k - d] - feet[k] : null; // + = feet rising

    // 2) Take-off: start from the fastest upward foot motion before the peak and walk back to the ground.
    let m = null, mv = -Infinity;
    for (let k = Math.max(d, peak - Math.round(0.6 * fps)); k <= peak; k++) { const v = up(k); if (isNum(v) && v > mv) { mv = v; m = k; } }
    let takeoff = null;
    if (m != null && mv > vthr) {
      let f = m;
      while (f - 1 >= d && isNum(up(f - 1)) && up(f - 1) > vthr) f--;
      const ground = maxIn(feet, f - d - 2, f - d);
      if (ground != null) for (let k = f - d; k <= m; k++) if (isNum(feet[k]) && feet[k] < ground - thr) { takeoff = k; break; }
      if (takeoff != null) {
        // sub-frame: extrapolate the rising feet back to ground level
        // include early airborne frames that sit just above the threshold-free ground line
        let k0 = takeoff;
        while (k0 - 1 > 0 && isNum(feet[k0 - 1]) && feet[k0 - 1] < ground - thrSmall) k0--;
        const pts = [];
        for (let k = k0; k <= Math.min(peak, k0 + Math.max(1, Math.round(0.015 * fps))); k++) if (isNum(feet[k])) pts.push([k, feet[k]]);
        const x = crossing(pts, ground);
        if (x != null) { res.takeoffT = clamp(x, takeoff - 1 - 2 * d, takeoff); takeoff = Math.ceil(res.takeoffT - 1e-9); }
      }
    }
    // 3) Landing: fastest downward foot motion after the peak, walk forward until the feet stop.
    const down = (k) => (isNum(feet[k + d]) && isNum(feet[k])) ? feet[k + d] - feet[k] : null; // + = feet falling
    let m2 = null, mv2 = -Infinity;
    for (let k = peak; k <= Math.min(n - 1 - d, peak + Math.round(0.7 * fps)); k++) { const v = down(k); if (isNum(v) && v > mv2) { mv2 = v; m2 = k; } }
    let landing = null;
    if (m2 != null && mv2 > vthr) {
      let f = m2;
      while (f + 1 + d < n && isNum(down(f + 1)) && down(f + 1) > vthr) f++;
      const ground = maxIn(feet, f + d, f + d + 2);
      if (ground != null) for (let k = m2; k <= Math.min(n - 1, f + d + 2); k++) if (isNum(feet[k]) && feet[k] >= ground - thr) { landing = k; break; }
      if (landing != null) {
        // sub-frame: extrapolate the falling feet forward to ground level
        let k1 = landing - 1;
        while (k1 + 1 < n && isNum(feet[k1 + 1]) && feet[k1 + 1] < ground - thrSmall) k1++;
        const pts = [];
        for (let k = Math.max(peak, k1 - Math.max(1, Math.round(0.015 * fps))); k <= k1; k++) if (isNum(feet[k])) pts.push([k, feet[k]]);
        const x = crossing(pts, ground);
        if (x != null) { res.landingT = clamp(x, k1, landing + 2 * d); landing = Math.ceil(res.landingT - 1e-9); }
      }
    }
    // Fallback: simple threshold on each side of the peak.
    if (takeoff == null) {
      const g = maxIn(feet, peak - Math.round(0.5 * fps), peak);
      for (let k = peak; k > 0; k--) if (isNum(feet[k - 1]) && feet[k - 1] >= g - thr) { takeoff = k; break; }
    }
    if (landing == null) {
      const g = maxIn(feet, peak, peak + Math.round(0.6 * fps));
      for (let k = peak; k < n; k++) if (isNum(feet[k]) && feet[k] >= g - thr) { landing = k; break; }
    }
    res.takeoff = takeoff; res.landing = landing;
    if (takeoff != null && landing != null) {
      const T = (landing - takeoff) / fps;
      res.confidence = (T > 0.25 && T < 1.2 && mv > vthr && mv2 > vthr) ? 'ok' : 'low';
    }

    // 4) Contact = highest hitting hand during the flight.
    const a = takeoff != null ? takeoff : Math.max(0, peak - Math.round(0.3 * fps));
    const b = landing != null ? landing : Math.min(n - 1, peak + Math.round(0.3 * fps));
    let side = null, contact = null, minY = Infinity;
    for (const s of ['L', 'R']) {
      const arr = s === 'L' ? sig.wrL : sig.wrR;
      for (let k = a; k <= b; k++) if (isNum(arr[k]) && arr[k] < minY) { minY = arr[k]; side = s; contact = k; }
    }
    res.side = side; res.contact = contact;
    return res;
  }

  /** Optional refinement: pick the frame near `contact` where the ball is closest to the hitting wrist. */
  function refineContactWithBall(hp, side, contact, ballPts, radius) {
    if (contact == null || !side || !ballPts) return contact;
    const wr = SIDES[side].wr;
    let best = contact, bestD = Infinity;
    for (let k = contact - radius; k <= contact + radius; k++) {
      const b = ballPts[k], p = hp[k];
      if (!b || !p) continue;
      const d = dist2([b.x, b.y], p.lm[wr]);
      if (d < bestD) { bestD = d; best = k; }
    }
    // only trust it when the ball really is at the hand (within ~15% of body height)
    const bh = hp[contact] ? bodyHeightPx(hp[contact]) : null;
    if (!bh || bestD > 0.15 * bh) return contact;
    return best;
  }

  // ---------- metrics ----------
  function wAngle(pose, a, b, c) { return pose && pose.w ? angleAt(pose.w[a], pose.w[b], pose.w[c]) : (pose ? angleAt(pose.lm[a], pose.lm[b], pose.lm[c]) : null); }
  function kneeAngle(pose, side) { const s = SIDES[side]; return wAngle(pose, s.hip, s.kn, s.an); }
  function elbowAngle(pose, side) { const s = SIDES[side]; return wAngle(pose, s.sh, s.el, s.wr); }
  function shoulderAngle(pose, side) { const s = SIDES[side]; return wAngle(pose, s.hip, s.sh, s.el); }

  /** Pixels per metre from the player's own body (needs their height). */
  function scaleFromBody(hp, around, fps, heightM) {
    if (!heightM || around == null) return null;
    const w = Math.max(2, Math.round(0.1 * fps));
    const vals = [];
    for (let k = around - w; k <= around + w; k++) if (hp[k]) { const c = chainPx(hp[k]); if (c) vals.push(c); }
    if (!vals.length) return null;
    // use an upper quantile - limbs only get shorter in 2D through foreshortening
    vals.sort((a, b) => a - b);
    const chain = vals[Math.floor(vals.length * 0.75)];
    return chain / (CHAIN_TO_HEIGHT * heightM);
  }

  function scaleFromLine(calib) {
    if (!calib || !calib.p1 || !calib.p2 || !calib.meters) return null;
    const px = dist2(calib.p1, calib.p2);
    return px > 5 ? px / calib.meters : null;
  }

  /** Fit straight-line velocity (px/s) to time-stamped points. */
  function fitVelocity(points) {
    const n = points.length;
    if (n < 2) return null;
    let st = 0, sx = 0, sy = 0, stt = 0, stx = 0, sty = 0;
    for (const p of points) { st += p.t; sx += p.x; sy += p.y; stt += p.t * p.t; stx += p.t * p.x; sty += p.t * p.y; }
    const den = n * stt - st * st;
    if (!den) return null;
    return { vx: (n * stx - st * sx) / den, vy: (n * sty - st * sy) / den };
  }

  /**
   * Compute every metric. Returns { values: {...}, notes: [...] }.
   * Each value: { v, unit, label, quality: 'good'|'estimate'|'na', how, reason? }
   */
  function computeMetrics(ctx) {
    const { hp, S, fps, events, settings, ballPts, calib } = ctx;
    const out = {};
    const put = (k, o) => { out[k] = o; };
    const { takeoff, contact, landing, side, approachStart } = events;
    const hasFlight = isNum(takeoff) && isNum(landing) && landing > takeoff;

    // --- Jump (timing physics: works with any camera) ---
    let T = null, tc = null;
    // Fractional (sub-frame) times from auto-detection are used only while the marks are untouched.
    const tTO = isNum(events.takeoffT) && Math.ceil(events.takeoffT - 1e-9) === takeoff ? events.takeoffT : takeoff - 0.5;
    const tLD = isNum(events.landingT) && Math.ceil(events.landingT - 1e-9) === landing ? events.landingT : landing - 0.5;
    if (hasFlight) {
      T = (tLD - tTO) / fps;
      put('flightTime', { v: T * 1000, unit: 'ms', label: 'Time in the air', quality: 'good', how: 'Landing frame minus take-off frame, divided by the frame rate.' });
      put('jumpHeight', { v: G * T * T / 8, unit: 'm', label: 'Jump height', quality: fps >= 100 ? 'good' : 'estimate',
        how: 'From time in the air: h = g·t²/8. Accurate to about ±' + Math.round(G * T * (1 / fps) / 4 * 100) + ' cm at ' + Math.round(fps) + ' fps.' });
    }
    if (hasFlight && isNum(contact)) {
      tc = (contact - tTO) / fps;
      const diff = tc - T / 2;
      put('contactTiming', { v: diff * 1000, unit: 'ms', label: 'Contact vs. peak of jump', quality: 'estimate', signed: true,
        how: 'Contact time compared with the top of the jump (half the time in the air). Negative = before the peak, positive = after.' });
      const v0 = G * T / 2;
      const rise = Math.max(0, v0 * tc - G * tc * tc / 2);
      put('riseAtContact', { v: rise, unit: 'm', label: 'Height gained at contact', quality: 'estimate', how: 'How high your body had risen at the contact frame, from jump physics.' });
      if (settings.reachM) {
        put('contactHeight', { v: settings.reachM + rise, unit: 'm', label: 'Contact height', quality: 'estimate',
          how: 'Your standing reach plus the height gained at contact. Assumes a fully extended arm at contact.' });
      } else {
        put('contactHeight', { v: null, unit: 'm', label: 'Contact height', quality: 'na', reason: 'Enter your standing reach under Player & camera.' });
      }
    }

    // --- Body angles (3D world landmarks: less sensitive to camera angle) ---
    if (isNum(contact) && side && hp[contact]) {
      put('elbowAtContact', { v: elbowAngle(hp[contact], side), unit: '°', label: 'Elbow angle at contact', quality: 'estimate', how: '180° = arm fully straight. Measured from the 3D pose.' });
      put('shoulderAtContact', { v: shoulderAngle(hp[contact], side), unit: '°', label: 'Shoulder angle at contact', quality: 'estimate', how: 'Angle between torso and upper arm. 180° = arm straight up in line with the body.' });
      // Hand speed relative to the body (world landmarks are hip-centred)
      const a = hp[contact - 1], b = hp[contact + 1];
      const wr = SIDES[side].wr;
      if (a && b && a.w && b.w) {
        put('handSpeed', { v: dist3(a.w[wr], b.w[wr]) / (2 / fps), unit: 'm/s', label: 'Hand speed at contact', quality: 'estimate',
          how: 'Speed of the hitting wrist relative to the hips around the contact frame (3D pose). Motion blur at low frame rates makes this rough.' });
      }
    }
    if (isNum(takeoff)) {
      let mn = null;
      for (let k = takeoff - Math.round(0.5 * fps); k <= takeoff; k++) {
        if (!hp[k]) continue;
        for (const s of ['L', 'R']) { const v = kneeAngle(hp[k], s); if (isNum(v) && (mn == null || v < mn)) mn = v; }
      }
      put('plantKnee', { v: mn, unit: '°', label: 'Knee bend before take-off', quality: 'estimate', how: 'Smallest knee angle in the last 0.5 s before take-off. 180° = straight leg.' });
    }
    if (isNum(landing)) {
      let mn = null;
      for (let k = landing; k <= landing + Math.round(0.35 * fps); k++) {
        if (!hp[k]) continue;
        for (const s of ['L', 'R']) { const v = kneeAngle(hp[k], s); if (isNum(v) && (mn == null || v < mn)) mn = v; }
      }
      put('landingKnee', { v: mn, unit: '°', label: 'Knee bend on landing', quality: 'estimate', how: 'Smallest knee angle in the 0.35 s after landing. Lower = softer landing.' });
      // Per-foot touchdown to spot one-foot landings
      const sig = hitterSignals(hp, S);
      const td = {};
      for (const s of ['L', 'R']) {
        const arr = medianFilter(s === 'L' ? sig.feetL : sig.feetR, 3);
        const g = maxIn(arr, landing, landing + Math.round(0.4 * fps));
        const bh = median(sig.bh.slice(landing - 5, landing + 5)) || 300;
        if (g == null) continue;
        for (let k = Math.max(0, landing - Math.round(0.15 * fps)); k <= landing + Math.round(0.4 * fps); k++) if (isNum(arr[k]) && arr[k] >= g - 0.04 * bh) { td[s] = k; break; }
      }
      if (isNum(td.L) && isNum(td.R)) {
        put('landingGap', { v: Math.abs(td.L - td.R) / fps * 1000, unit: 'ms', label: 'Gap between feet landing', quality: 'estimate',
          how: 'Time between the first and second foot touching down. Under ~70 ms counts as a two-foot landing.' });
      }
    }

    // --- Scale (for anything measured in metres from pixels) ---
    let pxPerM = scaleFromLine(calib), scaleSrc = pxPerM ? 'reference line' : null;
    if (!pxPerM) { pxPerM = scaleFromBody(hp, isNum(contact) ? contact : takeoff, fps, settings.heightM); scaleSrc = pxPerM ? 'player height' : null; }
    out._scale = { pxPerM, source: scaleSrc };

    // --- Ball speed (2D, camera-shift compensated) ---
    if (isNum(contact) && ballPts) {
      const pts = [];
      for (let k = contact; k <= contact + Math.max(3, Math.round(0.15 * fps)); k++) {
        const b = ballPts[k];
        if (b) pts.push({ t: k / fps, x: b.x - S[k][0], y: b.y - S[k][1] });
      }
      // use points after the hand has left the ball: drop the contact frame if we have enough others
      const use = pts.length > 2 ? pts.slice(1) : pts;
      const vel = fitVelocity(use);
      if (vel && pxPerM) {
        const v = Math.hypot(vel.vx, vel.vy) / pxPerM;
        const ang = Math.atan2(vel.vy, Math.abs(vel.vx)) * 180 / Math.PI;
        const side = settings.camera === 'tripod';
        put('ballSpeed', { v, unit: 'm/s', label: 'Ball speed', quality: side && fps >= 100 ? 'good' : 'estimate',
          how: 'Ball movement in the first frames after contact (' + use.length + ' points), corrected for camera movement, scaled by ' + scaleSrc + '. 2D only: underestimates if the ball travels toward or away from the camera.' });
        put('ballAngle', { v: ang, unit: '°', label: 'Ball angle (downward)', quality: 'estimate', how: 'Direction of the ball after contact, below horizontal, in the camera view.' });
      } else {
        put('ballSpeed', { v: null, unit: 'm/s', label: 'Ball speed', quality: 'na',
          reason: !pxPerM ? 'Needs a scale: enter player height or draw a reference line.' : 'Mark the ball in at least 2 frames after contact (Ball section).' });
      }
    } else {
      put('ballSpeed', { v: null, unit: 'm/s', label: 'Ball speed', quality: 'na', reason: 'Mark the ball in at least 2 frames after contact (Ball section).' });
    }

    // --- Approach ---
    if (isNum(approachStart) && isNum(takeoff) && takeoff > approachStart) {
      put('approachTime', { v: (takeoff - approachStart) / fps, unit: 's', label: 'Approach time', quality: 'good', how: 'From the approach-start mark to take-off.' });
    }
    if (isNum(takeoff)) {
      if (settings.camera === 'tripod' && pxPerM) {
        const sig = hitterSignals(hp, S);
        const a = takeoff - Math.round(0.6 * fps), b = takeoff - Math.round(0.15 * fps);
        if (isNum(sig.hipX[a]) && isNum(sig.hipX[b])) {
          put('approachSpeed', { v: Math.abs(sig.hipX[b] - sig.hipX[a]) / pxPerM / ((b - a) / fps), unit: 'm/s', label: 'Approach speed', quality: 'estimate',
            how: 'Average horizontal hip speed 0.6–0.15 s before take-off. Needs a side-on tripod video.' });
        }
      } else {
        put('approachSpeed', { v: null, unit: 'm/s', label: 'Approach speed', quality: 'na', reason: 'Needs a side-on video from a tripod (set under Player & camera) and a scale.' });
      }
    }
    return { values: out, notes: coachingNotes(out) };
  }

  /** Simple rules of thumb - phrased gently, they're hints not verdicts. */
  function coachingNotes(m) {
    const notes = [];
    const v = (k) => m[k] && isNum(m[k].v) ? m[k].v : null;
    const ct = v('contactTiming');
    if (ct != null) {
      if (Math.abs(ct) <= 50) notes.push({ tone: 'good', text: 'You hit close to the top of your jump. That\'s good timing.' });
      else if (ct < 0) notes.push({ tone: 'tip', text: 'Contact came ' + Math.round(-ct) + ' ms before your peak. A slightly later swing (or later approach) lets you hit higher.' });
      else notes.push({ tone: 'tip', text: 'Contact came ' + Math.round(ct) + ' ms after your peak, so you were already dropping. Try starting the approach a touch later.' });
    }
    const el = v('elbowAtContact');
    if (el != null) {
      if (el >= 155) notes.push({ tone: 'good', text: 'Arm close to straight at contact (' + Math.round(el) + '°), so you\'re using your full reach.' });
      else if (el < 140) notes.push({ tone: 'tip', text: 'Elbow bent at contact (' + Math.round(el) + '°). Reaching up through the ball adds height and power.' });
    }
    const pk = v('plantKnee');
    if (pk != null) {
      if (pk > 135) notes.push({ tone: 'tip', text: 'Shallow knee bend before take-off (' + Math.round(pk) + '°). Loading a bit deeper usually adds jump height.' });
      else if (pk < 75) notes.push({ tone: 'tip', text: 'Very deep knee bend before take-off (' + Math.round(pk) + '°). It can slow the transition into the jump.' });
      else notes.push({ tone: 'good', text: 'Knee bend before take-off (' + Math.round(pk) + '°) is in a typical range for a quick, strong jump.' });
    }
    const lk = v('landingKnee');
    if (lk != null && lk > 145) notes.push({ tone: 'warn', text: 'Stiff landing (knees only bent to ' + Math.round(lk) + '°). Bending more on landing takes load off knees and back.' });
    const lg = v('landingGap');
    if (lg != null && lg > 70) notes.push({ tone: 'warn', text: 'One foot landed ' + Math.round(lg) + ' ms before the other. Two-foot landings lower injury risk.' });
    return notes;
  }

  // ---------- camera shift (global motion) ----------
  function down2(img, w, h) {
    const w2 = w >> 1, h2 = h >> 1, out = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * w2 + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) >> 2;
    }
    return out;
  }
  function down2mask(m, w, h) {
    const w2 = w >> 1, h2 = h >> 1, out = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * w2 + x] = (m[i] && m[i + 1] && m[i + w] && m[i + w + 1]) ? 1 : 0;
    }
    return out;
  }
  function sadSearch(a, b, w, h, mask, cx, cy, r, step) {
    const margin = r + Math.max(Math.abs(cx), Math.abs(cy)) + 1;
    const costs = {};
    let best = null;
    let total = 0;
    for (let y = margin; y < h - margin; y += step) for (let x = margin; x < w - margin; x += step) if (mask[y * w + x]) total++;
    if (total < 50) return null;
    for (let dy = cy - r; dy <= cy + r; dy++) for (let dx = cx - r; dx <= cx + r; dx++) {
      let s = 0, n = 0;
      for (let y = margin; y < h - margin; y += step) {
        const row = y * w, rowB = (y + dy) * w + dx;
        for (let x = margin; x < w - margin; x += step) {
          if (!mask[row + x]) continue;
          const diff = a[row + x] - b[rowB + x];
          s += diff < 0 ? -diff : diff; n++;
        }
      }
      const c = s / n;
      costs[dx + ',' + dy] = c;
      if (!best || c < best.c) best = { dx, dy, c };
    }
    // sub-pixel refinement (parabola through neighbours)
    const sub = (cm, c0, cp) => (isNum(cm) && isNum(cp) && (cm + cp - 2 * c0) > 1e-6) ? 0.5 * (cm - cp) / (cm + cp - 2 * c0) : 0;
    const k = (dx, dy) => costs[dx + ',' + dy];
    best.fx = best.dx + clamp(sub(k(best.dx - 1, best.dy), best.c, k(best.dx + 1, best.dy)), -0.5, 0.5);
    best.fy = best.dy + clamp(sub(k(best.dx, best.dy - 1), best.c, k(best.dx, best.dy + 1)), -0.5, 0.5);
    return best;
  }
  /**
   * Estimate how far the background moved from `prev` to `cur` (grayscale, same size).
   * mask: 1 = usable background pixel (people masked out). Returns {dx, dy} in pixels or null.
   */
  function estimateShift(prev, cur, w, h, mask, maxR) {
    const R = maxR || 16;
    const p1 = down2(prev, w, h), c1 = down2(cur, w, h), m1 = down2mask(mask, w, h);
    const coarse = sadSearch(p1, c1, w >> 1, h >> 1, m1, 0, 0, Math.ceil(R / 2), 2);
    if (!coarse) return null;
    const fine = sadSearch(prev, cur, w, h, mask, coarse.dx * 2, coarse.dy * 2, 2, 2);
    if (!fine) return null;
    return { dx: fine.fx, dy: fine.fy, cost: fine.c };
  }
  /** Build a background mask with the given boxes (in mask pixels) blanked out. */
  function makeMask(w, h, boxes) {
    const m = new Uint8Array(w * h).fill(1);
    for (const b of boxes) {
      const x0 = clamp(Math.floor(b.x0), 0, w), x1 = clamp(Math.ceil(b.x1), 0, w);
      const y0 = clamp(Math.floor(b.y0), 0, h), y1 = clamp(Math.ceil(b.y1), 0, h);
      for (let y = y0; y < y1; y++) m.fill(0, y * w + x0, y * w + x1);
    }
    return m;
  }

  // ---------- ball tracking ----------
  /** Grab a (2r+1)^2 patch around (cx, cy) from RGBA data; returns gray + mean colour. */
  function makeTemplate(rgba, w, h, cx, cy, r) {
    r = Math.max(3, Math.round(r));
    const size = 2 * r + 1, g = new Float32Array(size * size);
    let mr = 0, mg = 0, mb = 0, n = 0, sum = 0;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const px = clamp(Math.round(cx) + x, 0, w - 1), py = clamp(Math.round(cy) + y, 0, h - 1);
      const i = (py * w + px) * 4;
      const v = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      g[(y + r) * size + (x + r)] = v; sum += v;
      if (x * x + y * y <= r * r * 0.6) { mr += rgba[i]; mg += rgba[i + 1]; mb += rgba[i + 2]; n++; }
    }
    const mean = sum / g.length;
    let norm = 0;
    for (let i = 0; i < g.length; i++) { g[i] -= mean; norm += g[i] * g[i]; }
    return { r, size, g, norm: Math.sqrt(norm), color: [mr / n, mg / n, mb / n] };
  }
  function blendTemplate(a, b, t) {
    if (!b || a.size !== b.size) return a;
    const g = new Float32Array(a.g.length);
    let norm = 0;
    for (let i = 0; i < g.length; i++) { g[i] = a.g[i] * (1 - t) + b.g[i] * t; norm += g[i] * g[i]; }
    return { r: a.r, size: a.size, g, norm: Math.sqrt(norm), color: a.color.map((c, i) => c * (1 - t) + b.color[i] * t) };
  }
  function nccAt(rgba, w, h, tpl, cx, cy, step) {
    const r = tpl.r, size = tpl.size;
    let sum = 0, sum2 = 0, cross = 0, n = 0, mr = 0, mg = 0, mb = 0, nc = 0;
    for (let y = -r; y <= r; y += step) for (let x = -r; x <= r; x += step) {
      const px = cx + x, py = cy + y;
      if (px < 0 || py < 0 || px >= w || py >= h) return -1;
      const i = (py * w + px) * 4;
      const v = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const t = tpl.g[(y + r) * size + (x + r)];
      sum += v; sum2 += v * v; cross += v * t; n++;
      if (x * x + y * y <= r * r * 0.6) { mr += rgba[i]; mg += rgba[i + 1]; mb += rgba[i + 2]; nc++; }
    }
    const varI = sum2 - sum * sum / n;
    // flat patches (blown-out walls, lights) carry no shape information
    if (varI / n < 9) return 0;
    let tn = 0, tsum = 0;
    if (step === 1) { tn = tpl.norm; }
    else {
      for (let y = -r; y <= r; y += step) for (let x = -r; x <= r; x += step) { const t = tpl.g[(y + r) * size + (x + r)]; tn += t * t; tsum += t; }
      tn = Math.sqrt(Math.max(0, tn - tsum * tsum / n));
    }
    if (tn <= 1e-6) return 0;
    const ncc = clamp((cross - (sum / n) * tsum) / (Math.sqrt(varI) * tn), -1, 1);
    const col = Math.hypot(mr / nc - tpl.color[0], mg / nc - tpl.color[1], mb / nc - tpl.color[2]) / 441;
    return ncc - 0.8 * col;
  }
  /** Search for the ball around a predicted position. Returns {x, y, score} or null. */
  function findBall(rgba, w, h, tpl, pred, searchR) {
    const step = Math.max(1, Math.round(tpl.r / 4));
    let best = null;
    const x0 = Math.round(pred[0] - searchR), x1 = Math.round(pred[0] + searchR);
    const y0 = Math.round(pred[1] - searchR), y1 = Math.round(pred[1] + searchR);
    for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
      const s = nccAt(rgba, w, h, tpl, x, y, step);
      // mild preference for the predicted spot
      const sc = s - 0.15 * Math.hypot(x - pred[0], y - pred[1]) / Math.max(searchR, 1);
      if (!best || sc > best.sc) best = { x, y, s, sc };
    }
    if (!best) return null;
    if (step > 1) {
      const c = best;
      for (let y = c.y - step; y <= c.y + step; y++) for (let x = c.x - step; x <= c.x + step; x++) {
        const s = nccAt(rgba, w, h, tpl, x, y, 1);
        const sc = s - 0.15 * Math.hypot(x - pred[0], y - pred[1]) / Math.max(searchR, 1);
        if (sc > best.sc) best = { x, y, s, sc };
      }
    }
    return { x: best.x, y: best.y, score: best.s };
  }
  /** Predict next ball position from previous points (constant acceleration when possible). */
  function predictBall(pts) {
    const n = pts.length;
    if (n === 1) return [pts[0][0], pts[0][1]];
    const a = pts[n - 1], b = pts[n - 2];
    if (n === 2) return [2 * a[0] - b[0], 2 * a[1] - b[1]];
    const c = pts[n - 3];
    return [3 * a[0] - 3 * b[0] + c[0], 3 * a[1] - 3 * b[1] + c[1]];
  }

  return {
    G, LM, SIDES, CONNECTIONS, CHAIN_TO_HEIGHT,
    median, medianFilter, angleAt, cumulativeShift, poseBox, chainPx, bodyHeightPx, lowestFootY,
    buildTracks, pickHitterTrack, poseAtPoint, followFromSeed, interpolateGaps,
    hitterSignals, detectEvents, refineContactWithBall,
    kneeAngle, elbowAngle, shoulderAngle, scaleFromBody, scaleFromLine, fitVelocity, computeMetrics, coachingNotes,
    estimateShift, makeMask, makeTemplate, blendTemplate, findBall, predictBall,
  };
});
