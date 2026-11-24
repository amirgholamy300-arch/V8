/* car.js - drive the simulated engine inside a sports car on a real map (topoexport data) */
(function () {
'use strict';
const T = window.THREE;
const clampv = (v, a, b) => v < a ? a : v > b ? b : v;
const CAR_COLORS = [['Blue', '#1d4e89'], ['White', '#e8e8ea'], ['Red', '#c1121f'], ['Black', '#15171a'], ['Yellow', '#f5b400'], ['Green', '#2a9d8f']];
const L_WB = 2.45, CLA = 1.6;

const CAR = {
  on: false, ready: false, loading: false, scene: null, cam: null, world: null, map: null,
  view: 0, tilt: false, steer: 0, ptr: 0, kb: 0, tiltV: 0,
  x: 0, z: 0, th: 0, y: 0, pitch: 0, roll: 0, vr: 0, cth: 0, shake: 0, crashCD: 0,
  wheelSpin: 0, color: +(localStorage.getItem('v8sim.carcol') || 0), mapName: '', custom: false,
  prevAuto: null, prevV: 0
};
window.CAR = CAR;

/* ================= small storage helper for a custom map ================= */
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('v8sim', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(k) { try { const db = await idb(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch (e) { return null; } }
async function idbSet(k, v) { try { const db = await idb(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; }); } catch (e) {} }
async function idbDel(k) { try { const db = await idb(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = res; }); } catch (e) {} }

/* ================= scene, sky, lights ================= */
function ensureScene() {
  if (CAR.scene) return;
  const sc = new T.Scene();
  const cv = document.createElement('canvas'); cv.width = 4; cv.height = 256;
  const cx = cv.getContext('2d'), g = cx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#5f94d6'); g.addColorStop(0.55, '#a9c8ee'); g.addColorStop(1, '#dbe6f0');
  cx.fillStyle = g; cx.fillRect(0, 0, 4, 256);
  sc.background = new T.CanvasTexture(cv);
  sc.fog = new T.Fog(0xcfdceb, 260, 1250);
  sc.add(new T.HemisphereLight(0xdbe9ff, 0x7a6b55, 0.85));
  const sun = new T.DirectionalLight(0xfff1d6, 0.95); sun.position.set(-300, 520, 220); sc.add(sun);
  const cam = new T.PerspectiveCamera(62, 1, 0.3, 3500);
  CAR.scene = sc; CAR.cam = cam;
  CAR.car = buildCar();
  sc.add(CAR.car.group);
  /* soft blob shadow under the car */
  const sc2 = document.createElement('canvas'); sc2.width = sc2.height = 64;
  const c2 = sc2.getContext('2d'), rg = c2.createRadialGradient(32, 32, 4, 32, 32, 31);
  rg.addColorStop(0, 'rgba(0,0,0,0.55)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  c2.fillStyle = rg; c2.fillRect(0, 0, 64, 64);
  const shadow = new T.Mesh(new T.PlaneGeometry(2.7, 5.6), new T.MeshBasicMaterial({ map: new T.CanvasTexture(sc2), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 2;
  CAR.shadow = shadow; sc.add(shadow);
}

/* ================= the car (GT3-style body built from lofted sections) ================= */
function loft(st, seg, n) {
  const pos = [], idx = [];
  st.forEach(s => {
    const yc = (s.y0 + s.y1) / 2, hh = Math.max(0.02, (s.y1 - s.y0) / 2), e = 2 / n;
    for (let k = 0; k < seg; k++) {
      const a = k / seg * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      pos.push(s.hw * Math.sign(c) * Math.pow(Math.abs(c), e), yc + hh * Math.sign(sn) * Math.pow(Math.abs(sn), e), s.z);
    }
  });
  for (let i = 0; i < st.length - 1; i++) for (let k = 0; k < seg; k++) {
    const a = i * seg + k, b = i * seg + (k + 1) % seg, c = (i + 1) * seg + k, d = (i + 1) * seg + (k + 1) % seg;
    idx.push(a, b, c, b, d, c);
  }
  [0, st.length - 1].forEach(si => {
    const s = st[si], c0 = pos.length / 3;
    pos.push(0, (s.y0 + s.y1) / 2, s.z);
    for (let k = 0; k < seg; k++) idx.push(c0, si * seg + (k + 1) % seg, si * seg + k);
  });
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function buildCar() {
  const grp = new T.Group(), body = new T.Group();
  grp.add(body);
  const col = new T.Color(CAR_COLORS[CAR.color % CAR_COLORS.length][1]);
  const paint = new T.MeshPhongMaterial({ color: col, shininess: 90, specular: 0x555555, side: T.DoubleSide });
  const glass = new T.MeshPhongMaterial({ color: 0x0c1218, shininess: 120, specular: 0x8899aa, side: T.DoubleSide });
  const dark = new T.MeshPhongMaterial({ color: 0x14161a, shininess: 20 });
  const lower = [
    { z: 2.28, hw: 0.55, y0: 0.22, y1: 0.50 }, { z: 2.18, hw: 0.78, y0: 0.15, y1: 0.60 }, { z: 1.90, hw: 0.90, y0: 0.12, y1: 0.74 },
    { z: 1.40, hw: 0.93, y0: 0.12, y1: 0.78 }, { z: 0.90, hw: 0.92, y0: 0.12, y1: 0.76 }, { z: 0.20, hw: 0.92, y0: 0.12, y1: 0.80 },
    { z: -0.50, hw: 0.93, y0: 0.12, y1: 0.86 }, { z: -1.20, hw: 0.98, y0: 0.12, y1: 0.95 }, { z: -1.80, hw: 0.96, y0: 0.14, y1: 0.98 },
    { z: -2.20, hw: 0.88, y0: 0.18, y1: 0.88 }, { z: -2.28, hw: 0.70, y0: 0.22, y1: 0.80 }];
  const cabin = [
    { z: 0.95, hw: 0.62, y0: 0.74, y1: 0.78 }, { z: 0.70, hw: 0.60, y0: 0.76, y1: 1.10 }, { z: 0.25, hw: 0.58, y0: 0.79, y1: 1.26 },
    { z: -0.30, hw: 0.58, y0: 0.83, y1: 1.28 }, { z: -0.90, hw: 0.60, y0: 0.90, y1: 1.20 }, { z: -1.50, hw: 0.70, y0: 0.95, y1: 1.00 },
    { z: -1.90, hw: 0.78, y0: 0.96, y1: 0.99 }];
  const mBody = new T.Mesh(loft(lower, 30, 3.0), paint), mCab = new T.Mesh(loft(cabin, 24, 2.6), glass);
  body.add(mBody); body.add(mCab);
  const box = (w, h, d, mat, x, y, z) => { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); body.add(m); return m; };
  box(1.7, 0.04, 0.34, dark, 0, 0.15, 2.15);                       /* front splitter */
  box(1.45, 0.14, 0.38, dark, 0, 0.2, -2.2);                       /* diffuser */
  const wing = box(1.78, 0.04, 0.42, dark, 0, 1.24, -2.06); wing.rotation.x = -0.14;
  box(0.03, 0.24, 0.52, dark, 0.9, 1.2, -2.06); box(0.03, 0.24, 0.52, dark, -0.9, 1.2, -2.06);
  [0.55, -0.55].forEach(x => { const s = box(0.05, 0.3, 0.09, dark, x, 1.08, -1.98); s.rotation.x = 0.35; });
  box(0.1, 0.06, 0.12, dark, 0.95, 0.96, 0.62); box(0.1, 0.06, 0.12, dark, -0.95, 0.96, 0.62);   /* mirrors */
  const tail = new T.MeshPhongMaterial({ color: 0x300000, emissive: 0xaa0808, emissiveIntensity: 0.35 });
  box(1.3, 0.05, 0.05, tail, 0, 0.86, -2.2);                       /* light bar */
  const head = new T.MeshPhongMaterial({ color: 0xffffff, emissive: 0xfff2c8, emissiveIntensity: 0.6 });
  [0.58, -0.58].forEach(x => { const h = new T.Mesh(new T.CylinderGeometry(0.1, 0.1, 0.06, 16), head); h.rotation.x = Math.PI / 2; h.position.set(x, 0.62, 2.1); body.add(h); });
  /* twin tailpipes (centre exit) and flames */
  const flames = [];
  [0.17, -0.17].forEach(x => {
    const t = new T.Mesh(new T.CylinderGeometry(0.06, 0.07, 0.12, 14), new T.MeshPhongMaterial({ color: 0xb8b8bc, shininess: 100 }));
    t.rotation.x = Math.PI / 2; t.position.set(x, 0.3, -2.32); body.add(t);
    const f = new T.Mesh(new T.ConeGeometry(1, 1, 10, 1, true), new T.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.85, side: T.DoubleSide, depthWrite: false }));
    f.rotation.x = -Math.PI / 2; f.position.set(x, 0.3, -2.38); f.visible = false; body.add(f); flames.push(f);
  });
  /* wheels: arch liners are fixed, tyre groups steer and spin */
  const tyre = new T.MeshPhongMaterial({ color: 0x0b0b0d, shininess: 10 }), rim = new T.MeshPhongMaterial({ color: 0xc9ccd2, shininess: 110, specular: 0xffffff });
  const wheels = [];
  [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(a => {
    const front = a[1] > 0, r = front ? 0.35 : 0.365, wd = front ? 0.27 : 0.32, tx = (front ? 0.805 : 0.79) * a[0], az = front ? 1.23 : -1.22;
    const arch = new T.Mesh(new T.CylinderGeometry(r + 0.07, r + 0.07, 0.06, 28), dark);
    arch.rotation.z = Math.PI / 2; arch.position.set(a[0] * (front ? 0.905 : 0.935), r, az); body.add(arch);
    const steer = new T.Group(); steer.position.set(tx, r, az); body.add(steer);
    const spin = new T.Group(); steer.add(spin);
    const tm = new T.Mesh(new T.CylinderGeometry(r, r, wd, 30), tyre); tm.rotation.z = Math.PI / 2; spin.add(tm);
    const rm = new T.Mesh(new T.CylinderGeometry(r * 0.68, r * 0.68, wd + 0.012, 24), rim); rm.rotation.z = Math.PI / 2; spin.add(rm);
    for (let k = 0; k < 5; k++) {
      const sp = new T.Mesh(new T.BoxGeometry(wd + 0.02, r * 1.2, 0.03), dark);
      sp.rotation.x = k / 5 * Math.PI; spin.add(sp);
    }
    wheels.push({ steer: steer, spin: spin, front: front });
  });
  return { group: grp, body: body, paint: paint, tail: tail, wheels: wheels, flames: flames };
}

function setCarColor(i) {
  CAR.color = i; localStorage.setItem('v8sim.carcol', i);
  if (CAR.car) CAR.car.paint.color.set(CAR_COLORS[i % CAR_COLORS.length][1]);
}

/* ================= world from a converted map ================= */
function makeWorld(map) {
  const nx = map.nx, nz = map.nz, st = map.step, x0 = -map.W / 2, z0 = -map.H / 2;
  const raw = Topo.unb64(map.h), u16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  const hg = new Float32Array(nx * nz);
  for (let i = 0; i < hg.length; i++) hg[i] = map.hmin + u16[i] / 20;
  const heightAt = (x, z) => {
    let fx = (x - x0) / st, fz = (z - z0) / st;
    fx = clampv(fx, 0, nx - 1.001); fz = clampv(fz, 0, nz - 1.001);
    const i = fx | 0, j = fz | 0, a = fx - i, b = fz - j;
    const h00 = hg[j * nx + i], h10 = hg[j * nx + i + 1], h01 = hg[(j + 1) * nx + i], h11 = hg[(j + 1) * nx + i + 1];
    return (h00 * (1 - a) + h10 * a) * (1 - b) + (h01 * (1 - a) + h11 * a) * b;
  };
  const group = new T.Group();
  const inRing = (p, x, z) => {
    let ins = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  };
  const bboxOf = p => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (let i = 0; i < p.length; i += 2) { a = Math.min(a, p[i]); c = Math.max(c, p[i]); b = Math.min(b, p[i + 1]); d = Math.max(d, p[i + 1]); } return [a, b, c, d]; };
  const gz = map.green.map(p => ({ p: p, bb: bboxOf(p) })), wz = map.water.map(p => ({ p: p, bb: bboxOf(p) }));
  const inAny = (arr, x, z) => { for (let q = 0; q < arr.length; q++) { const b = arr[q].bb; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inRing(arr[q].p, x, z)) return true; } return false; };

  /* ---- terrain mesh ---- */
  {
    const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = x0 + i * st, z = z0 + j * st, h = hg[k];
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      const hl = hg[j * nx + Math.max(0, i - 1)], hr = hg[j * nx + Math.min(nx - 1, i + 1)], hd = hg[Math.max(0, j - 1) * nx + i], hu = hg[Math.min(nz - 1, j + 1) * nx + i];
      const slope = (Math.abs(hr - hl) + Math.abs(hu - hd)) / (2 * st);
      const n = (Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1, nn = 0.94 + 0.06 * Math.abs(n);
      let r = 0.60, g = 0.54, b = 0.38;                                /* dry hillside */
      const t = clampv(slope * 1.6, 0, 1); r += (0.46 - r) * t; g += (0.41 - g) * t; b += (0.34 - b) * t;
      if (inAny(gz, x, z)) { r = 0.27; g = 0.46; b = 0.22; }
      if (inAny(wz, x, z)) { r = 0.18; g = 0.38; b = 0.6; }
      col[k * 3] = r * nn; col[k * 3 + 1] = g * nn; col[k * 3 + 2] = b * nn;
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6); let p = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setIndex(new T.BufferAttribute(idx, 1)); g.computeVertexNormals();
    group.add(new T.Mesh(g, new T.MeshPhongMaterial({ vertexColors: true, shininess: 0 })));
    /* ground beyond the map edge */
    const far = new T.Mesh(new T.PlaneGeometry(9000, 9000), new T.MeshBasicMaterial({ color: 0xa79b80 }));
    far.rotation.x = -Math.PI / 2; far.position.y = map.hmin - 3; group.add(far);
  }

  /* ---- roads (draped ribbons) and a spatial index used for grip ---- */
  const RC = 16, rh = new Map(), rk = (i, j) => i * 100003 + j;
  {
    const pos = [], col = [], idx = [];
    const densify = (p, mx) => {
      const o = [p[0], p[1]];
      for (let i = 2; i < p.length; i += 2) {
        const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1], d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / mx));
        for (let k = 1; k <= n; k++) o.push(ax + (bx - ax) * k / n, az + (bz - az) * k / n);
      }
      return o;
    };
    const ribbon = (pts, hw, off, c) => {
      const n = pts.length / 2, base = pos.length / 3;
      let lt = [0, 1];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        let tx = pts[b * 2] - pts[a * 2], tz = pts[b * 2 + 1] - pts[a * 2 + 1];
        const l = Math.hypot(tx, tz);
        if (l > 1e-6) lt = [tx / l, tz / l];
        const nx_ = -lt[1], nz_ = lt[0], x = pts[i * 2], z = pts[i * 2 + 1], y = heightAt(x, z) + off;
        pos.push(x + nx_ * hw, y, z + nz_ * hw, x - nx_ * hw, y, z - nz_ * hw);
        col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
      }
      for (let i = 0; i < n - 1; i++) {
        const l0 = base + i * 2, r0 = l0 + 1, l1 = l0 + 2, r1_ = l0 + 3;
        idx.push(l0, l1, r0, r0, l1, r1_);
      }
    };
    map.roads.forEach(r => {
      const hw = Math.max(r.w * 1.25, 4.5) / 2, major = r.t === 'Major', pts = densify(r.p, 3);
      ribbon(pts, hw, major ? 0.075 : 0.065, major ? [0.22, 0.23, 0.26] : [0.28, 0.29, 0.32]);
      if (major) ribbon(pts, 0.12, 0.09, [0.85, 0.74, 0.28]);
      for (let i = 2; i < r.p.length; i += 2) {
        const x1 = r.p[i - 2], z1 = r.p[i - 1], x2 = r.p[i], z2 = r.p[i + 1], seg = [x1, z1, x2, z2, hw];
        const i0 = Math.floor((Math.min(x1, x2) - hw) / RC), i1 = Math.floor((Math.max(x1, x2) + hw) / RC);
        const j0 = Math.floor((Math.min(z1, z2) - hw) / RC), j1 = Math.floor((Math.max(z1, z2) + hw) / RC);
        for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) { const k = rk(a, b); (rh.get(k) || rh.set(k, []).get(k)).push(seg); }
      }
    });
    if (pos.length) {
      const g = new T.BufferGeometry(), nrm = new Float32Array(pos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(col), 3));
      g.setIndex(new T.BufferAttribute(new Uint32Array(idx), 1));
      const m = new T.Mesh(g, new T.MeshPhongMaterial({ vertexColors: true, shininess: 8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      group.add(m);
    }
  }
  const onRoad = (x, z) => {
    const c = rh.get(rk(Math.floor(x / RC), Math.floor(z / RC)));
    if (!c) return false;
    for (let q = 0; q < c.length; q++) {
      const s = c[q], dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - s[0]) * dx + (z - s[1]) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - (s[0] + dx * t), z - (s[1] + dz * t)) <= s[4] + 0.3) return true;
    }
    return false;
  };

  /* ---- buildings (merged, solid for collisions) ---- */
  const BC = 30, bh = new Map(), blist = [];
  {
    const pos = [], col = [], pal = [[0.85, 0.81, 0.76], [0.79, 0.72, 0.62], [0.9, 0.88, 0.83], [0.73, 0.7, 0.66], [0.83, 0.66, 0.54], [0.66, 0.7, 0.74]];
    map.bld.forEach((b, id) => {
      const p = b.p, n = p.length / 2;
      let hmn = 1e9, hmx = -1e9;
      for (let i = 0; i < n; i++) { const h = heightAt(p[i * 2], p[i * 2 + 1]); if (h < hmn) hmn = h; if (h > hmx) hmx = h; }
      const yb = hmn - 0.5, yt = hmx + b.h, c = pal[(id * 7 + (n | 0)) % pal.length];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
        pos.push(ax, yb, az, bx, yb, bz, bx, yt, bz, ax, yb, az, bx, yt, bz, ax, yt, az);
        for (let k = 0; k < 6; k++) col.push(c[0], c[1], c[2]);
      }
      const tri = T.ShapeUtils.triangulateShape(Array.from({ length: n }, (_, i) => new T.Vector2(p[i * 2], p[i * 2 + 1])), []);
      tri.forEach(t => t.forEach(v => { pos.push(p[v * 2], yt, p[v * 2 + 1]); col.push(c[0] * 0.62, c[1] * 0.6, c[2] * 0.58); }));
      const bb = bboxOf(p), e = { p: p, bb: bb }; blist.push(e);
      for (let a = Math.floor(bb[0] / BC); a <= Math.floor(bb[2] / BC); a++) for (let d = Math.floor(bb[1] / BC); d <= Math.floor(bb[3] / BC); d++) { const k = rk(a, d); (bh.get(k) || bh.set(k, []).get(k)).push(e); }
    });
    if (pos.length) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(col), 3));
      g.computeVertexNormals();
      group.add(new T.Mesh(g, new T.MeshPhongMaterial({ vertexColors: true, shininess: 6, side: T.DoubleSide })));
    }
  }
  const inBuilding = (x, z) => {
    const c = bh.get(rk(Math.floor(x / BC), Math.floor(z / BC)));
    if (!c) return false;
    for (let q = 0; q < c.length; q++) { const e = c[q], b = e.bb; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inRing(e.p, x, z)) return true; }
    return false;
  };

  /* ---- trees (instanced) ---- */
  {
    const nt = (map.trees.length / 4) | 0;
    if (nt > 0) {
      const crownG = new T.ConeGeometry(1, 1, 7); crownG.translate(0, 0.5, 0);
      const trunkG = new T.CylinderGeometry(0.12, 0.18, 1, 5); trunkG.translate(0, 0.5, 0);
      const crowns = new T.InstancedMesh(crownG, new T.MeshPhongMaterial({ shininess: 0 }), nt);
      const trunks = new T.InstancedMesh(trunkG, new T.MeshPhongMaterial({ color: 0x5a4330, shininess: 0 }), nt);
      const d = new T.Object3D(), c = new T.Color();
      for (let i = 0; i < nt; i++) {
        const x = map.trees[i * 4] / 10, z = map.trees[i * 4 + 1] / 10, h = map.trees[i * 4 + 2] / 10, cr = map.trees[i * 4 + 3] / 10, y = heightAt(x, z);
        d.position.set(x, y, z); d.scale.set(0.5, h * 0.4, 0.5); d.updateMatrix(); trunks.setMatrixAt(i, d.matrix);
        d.position.set(x, y + h * 0.3, z); d.scale.set(cr / 2, h * 0.75, cr / 2); d.updateMatrix(); crowns.setMatrixAt(i, d.matrix);
        const v = Math.abs((Math.sin(i * 91.7) * 4375.85) % 1);
        c.setRGB(0.16 + v * 0.12, 0.34 + v * 0.18, 0.15 + v * 0.07); crowns.setColorAt(i, c);
      }
      crowns.instanceMatrix.needsUpdate = true; trunks.instanceMatrix.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
      crowns.frustumCulled = false; trunks.frustumCulled = false;
      group.add(crowns); group.add(trunks);
    }
  }
  return { group: group, heightAt: heightAt, onRoad: onRoad, inBuilding: inBuilding, W: map.W, H: map.H };
}

function disposeGroup(g) {
  g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
}

function installMap(map, custom) {
  ensureScene();
  if (CAR.world) { CAR.scene.remove(CAR.world.group); disposeGroup(CAR.world.group); CAR.world = null; }
  CAR.map = map; CAR.custom = !!custom; CAR.mapName = map.name || 'Map';
  CAR.world = makeWorld(map);
  CAR.scene.add(CAR.world.group);
  CAR.ready = true; CAR.loading = false;
  resetCar();
  const ma = document.getElementById('mapinfo'); if (ma) ma.textContent = CAR.mapName;
}

function fallbackMap() {
  const nx = 3, nz = 3, u = new Uint16Array(nx * nz);
  return {
    v: 1, name: 'Test track (flat)', W: 800, H: 800, nx: nx, nz: nz, step: 400, hmin: 0, h: Topo.b64(new Uint8Array(u.buffer)),
    roads: [{ w: 9, t: 'Major', p: [-380, 0, 380, 0] }, { w: 9, t: 'Major', p: [380, 0, 380, 300, 0, 380, -380, 300] }], bld: [], trees: [], green: [], water: [], wl: [],
    spawn: { x: -340, z: 0, th: Math.PI / 2 }
  };
}

async function loadDefault() {
  if (CAR.loading) return;
  CAR.loading = true; CAR.ready = false;
  toast('Loading map…');
  await new Promise(r => setTimeout(r, 40));
  let map = null;
  try { const r = await fetch('map-la.json'); if (r.ok) map = await r.json(); } catch (e) {}
  if (!map) { map = fallbackMap(); toast('Map file not found, using a flat test track'); }
  try { installMap(map, false); } catch (e) { console.error(e); CAR.loading = false; toast('Map error: ' + e.message); }
}

async function loadFiles(files) {
  if (!files || !files.length) return;
  CAR.loading = true; toast('Reading map files…');
  try {
    const L = {}; let direct = null, name = 'Custom map';
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (n.endsWith('.dxf')) { toast('DXF is not supported. Use the .zip from topoexport (it holds GeoJSON).'); CAR.loading = false; return; }
      if (n.endsWith('.zip')) {
        name = f.name.replace(/\.zip$/i, '');
        const ents = await Topo.readZip(await f.arrayBuffer());
        for (const k of Object.keys(ents)) { const j = JSON.parse(new TextDecoder().decode(ents[k])), c = Topo.classify(k, j); if (c) L[c] = j; }
      } else {
        const j = JSON.parse(await f.text());
        if (j && j.v && j.h && j.roads) direct = j; else { const c = Topo.classify(f.name, j); if (c) L[c] = j; }
      }
    }
    toast('Building the map…');
    await new Promise(r => setTimeout(r, 60));
    const map = direct || Topo.convert(L, { name: name, n: 200 });
    await idbSet('custom-map', map); localStorage.setItem('v8sim.map', 'custom');
    installMap(map, true);
    toast('Map loaded: ' + (map.roads.length) + ' roads, ' + (map.bld.length) + ' buildings');
  } catch (e) { console.error(e); CAR.loading = false; toast('Could not read the map: ' + e.message); }
  if (window.renderSheet) renderSheet();
}

async function startMap() {
  if (localStorage.getItem('v8sim.map') === 'custom') {
    const m = await idbGet('custom-map');
    if (m) { try { installMap(m, true); return; } catch (e) { console.error(e); } }
  }
  await loadDefault();
}

/* ================= driving ================= */
function resetCar() {
  const s = (CAR.map && CAR.map.spawn) || { x: 0, z: 0, th: 0 };
  CAR.x = s.x; CAR.z = s.z; CAR.th = s.th; CAR.cth = s.th; CAR.vr = 0; CAR.steer = 0;
  S.v = 0; S.w = Math.max(S.w, 0);
  if (CAR.world) CAR.y = CAR.world.heightAt(CAR.x, CAR.z);
  CAR.pitch = 0; CAR.roll = 0; CAR.prevV = 0;
}

function pointsOf(x, z, th, lz, lxs) {
  const c = Math.cos(th), s = Math.sin(th);
  return [x + lxs * c + lz * s, z - lxs * s + lz * c];
}

function hitBuilding(x, z, th) {
  const W = CAR.world, pts = [[0.95, 2.2], [-0.95, 2.2], [0.95, -2.2], [-0.95, -2.2], [0.95, 0], [-0.95, 0], [0, 2.3], [0, -2.3]];
  for (let i = 0; i < pts.length; i++) { const p = pointsOf(x, z, th, pts[i][1], pts[i][0]); if (W.inBuilding(p[0], p[1])) return true; }
  return false;
}

function step(dt) {
  if (!CAR.scene) return;
  dt = Math.min(dt, 0.05);
  const cam = CAR.cam, cvs = renderer.domElement, asp = (cvs.clientWidth || 1) / (cvs.clientHeight || 1);
  if (Math.abs(cam.aspect - asp) > 0.001) { cam.aspect = asp; cam.updateProjectionMatrix(); }
  const W = CAR.world;
  if (!W) { cam.position.set(0, 3, -8); cam.lookAt(0, 1, 0); return; }

  const m = P.m, g = 9.81;
  /* ---- steering input: touch drag, keys, tilt ---- */
  const cmd = CAR.tilt ? CAR.tiltV : (CAR.ptr !== 0 ? CAR.ptr : CAR.kb);
  CAR.steer += (cmd - CAR.steer) * Math.min(1, dt * (cmd === 0 ? 7 : 10));

  /* ---- traction and grip ---- */
  let vs = S.v - CAR.vr;
  const v = Math.abs(vs), road = W.onRoad(CAR.x, CAR.z);
  const mu = road ? 1.15 : 0.55, df = 0.5 * 1.2 * CLA * S.v * S.v;
  S.fmax = 1.15 * mu * (0.62 * m * g + 0.45 * df);
  const fu = Math.min(1, Math.abs(S.Fwu || 0) / S.fmax), ul = Math.max(fu, Math.min(1, S.brk || 0) * 0.85);
  const aCap = mu * (g + df / m) * Math.sqrt(Math.max(0.15, 1 - ul * ul));
  const dmax = 0.55 / (1 + Math.pow(v / 10, 2)), del = CAR.steer * dmax;
  let r = v > 0.15 ? vs * Math.tan(del) / L_WB : 0, skid = 0;
  const ades = Math.abs(v * r);
  if (ades > aCap) { skid = ades - aCap; r = Math.sign(r) * aCap / Math.max(v, 0.5); }

  /* ---- reverse: hold brake in neutral when stopped ---- */
  if (S.v < 0.6 && S.gear === 0 && (S.brk || 0) > 0.3 && (S.thr || 0) < 0.15) CAR.vr = Math.min(7, CAR.vr + 4 * dt * S.brk);
  else CAR.vr = Math.max(0, CAR.vr - CAR.vr * dt * 3 - dt * 0.5);

  /* ---- extra resistance for the engine physics (off-road, scrub, hills) ---- */
  const slope = Math.sin(CAR.pitch + (CAR.pitchG || 0));
  S.xF = (road ? 0 : 0.09 * m * g) + skid * m * 0.35 + m * g * clampv(CAR.pitchG || 0, -0.5, 0.5) * clampv(S.v / 3, 0, 1);

  /* ---- move ---- */
  CAR.th += r * dt;
  const px = CAR.x, pz = CAR.z;
  CAR.x += Math.sin(CAR.th) * vs * dt; CAR.z += Math.cos(CAR.th) * vs * dt;
  const hx = W.W / 2 - 6, hz = W.H / 2 - 6;
  if (Math.abs(CAR.x) > hx || Math.abs(CAR.z) > hz) { CAR.x = clampv(CAR.x, -hx, hx); CAR.z = clampv(CAR.z, -hz, hz); S.v *= 0.9; }
  CAR.crashCD -= dt;
  if (hitBuilding(CAR.x, CAR.z, CAR.th)) {
    CAR.x = px; CAR.z = pz;
    if (S.v > 3 && CAR.crashCD <= 0) { CAR.shake = Math.min(1, S.v / 25); CAR.crashCD = 1; toast('Crash!'); }
    S.v *= 0.2; CAR.vr = 0;
  }

  /* ---- ground pose ---- */
  const wp = [[0.8, 1.23], [-0.8, 1.23], [0.79, -1.22], [-0.79, -1.22]].map(a => { const p = pointsOf(CAR.x, CAR.z, CAR.th, a[1], a[0]); return W.heightAt(p[0], p[1]); });
  const yT = (wp[0] + wp[1] + wp[2] + wp[3]) / 4;
  const pG = Math.atan2((wp[0] + wp[1]) / 2 - (wp[2] + wp[3]) / 2, 2.45), rG = Math.atan2((wp[0] + wp[2]) / 2 - (wp[1] + wp[3]) / 2, 1.6);
  CAR.pitchG = pG;
  const kk = Math.min(1, dt * 14);
  CAR.y += (yT - CAR.y) * kk;
  const ax = (S.v - CAR.prevV) / Math.max(dt, 1e-3); CAR.prevV = S.v;
  const ay = vs * r;
  const pitchT = pG + clampv(0.0035 * ax, -0.05, 0.05), rollT = rG + clampv(0.006 * ay, -0.08, 0.08);
  CAR.pitch += (pitchT - CAR.pitch) * Math.min(1, dt * 7); CAR.roll += (rollT - CAR.roll) * Math.min(1, dt * 7);

  /* ---- car visuals ---- */
  const car = CAR.car, gp = car.group;
  gp.position.set(CAR.x, CAR.y, CAR.z);
  gp.rotation.order = 'YXZ'; gp.rotation.y = CAR.th; gp.rotation.x = -CAR.pitch; gp.rotation.z = CAR.roll;
  CAR.shadow.position.set(CAR.x, CAR.y + 0.04, CAR.z); CAR.shadow.rotation.set(-Math.PI / 2, 0, 0); CAR.shadow.rotation.z = CAR.th;
  CAR.wheelSpin += vs / 0.355 * dt;
  car.wheels.forEach(w => { w.spin.rotation.x = CAR.wheelSpin; if (w.front) w.steer.rotation.y = del; });
  car.tail.emissiveIntensity = (S.brk || 0) > 0.1 ? 1.2 : 0.35;
  for (let i = 0; i < 2; i++) {
    const f = window.FLM && FLM[i], fm = car.flames[i];
    if (f && f.life > 0.02) {
      const L = Math.min(1, f.life), len = Math.max(0.05, (f.len || 10) * 0.05 * (0.4 + L)), rad = Math.max(0.03, (f.rr || 3) * 0.045);
      fm.visible = true; fm.scale.set(rad, len, rad); fm.position.z = -2.38 - len * 0.5;
    } else fm.visible = false;
  }

  /* ---- camera ---- */
  let dth = CAR.th - CAR.cth; dth = Math.atan2(Math.sin(dth), Math.cos(dth)); CAR.cth += dth * Math.min(1, dt * 3.2);
  const spd = Math.abs(S.v), fwdx = Math.sin(CAR.th), fwdz = Math.cos(CAR.th), cfx = Math.sin(CAR.cth), cfz = Math.cos(CAR.cth);
  CAR.shake = Math.max(0, CAR.shake - dt * 1.6);
  const sh = CAR.shake * 0.35;
  if (CAR.view === 2) {
    cam.position.set(CAR.x + fwdx * 0.55, CAR.y + 1.1, CAR.z + fwdz * 0.55);
    cam.lookAt(CAR.x + fwdx * 30, CAR.y + 1.05 - CAR.pitch * 6, CAR.z + fwdz * 30);
    cam.rotateZ(-CAR.roll * 0.6);
  } else {
    const dist = CAR.view === 1 ? 4.7 : 7.3, hgt = CAR.view === 1 ? 1.55 : 2.5;
    const tx = CAR.x - cfx * dist, tz = CAR.z - cfz * dist, ty = Math.max(CAR.y + hgt, W.heightAt(tx, tz) + 1.0);
    cam.position.set(tx + (Math.random() - 0.5) * sh, ty + (Math.random() - 0.5) * sh, tz + (Math.random() - 0.5) * sh);
    cam.lookAt(CAR.x + fwdx * 3, CAR.y + 1.0, CAR.z + fwdz * 3);
  }
  const fov = 62 + Math.min(18, spd * 0.22);
  if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 4); cam.updateProjectionMatrix(); }
}
CAR.step = step;

/* ================= input ================= */
function bindInput() {
  const cv = renderer.domElement;
  let pid = null, sx = 0;
  cv.addEventListener('pointerdown', e => { if (!CAR.on || pid !== null) return; pid = e.pointerId; sx = e.clientX; });
  cv.addEventListener('pointermove', e => { if (!CAR.on || e.pointerId !== pid) return; CAR.ptr = clampv(-(e.clientX - sx) / 80, -1, 1); });
  const up = e => { if (e.pointerId === pid) { pid = null; CAR.ptr = 0; } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  addEventListener('keydown', e => { if (!CAR.on) return; if (e.key === 'ArrowLeft' || e.key === 'a') CAR.kb = 1; if (e.key === 'ArrowRight' || e.key === 'd') CAR.kb = -1; });
  addEventListener('keyup', e => { if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'ArrowRight' || e.key === 'd') CAR.kb = 0; });
  addEventListener('deviceorientation', e => { if (CAR.tilt && e.gamma !== null) CAR.tiltV = clampv(-e.gamma / 26, -1, 1); });
}

function mkBtn(id, cls, svg, onclick, label) {
  const b = document.createElement('button');
  b.className = 'vbtn carui ' + cls; b.id = id; b.setAttribute('aria-label', label); b.innerHTML = svg;
  b.addEventListener('click', onclick);
  b.addEventListener('pointerdown', e => e.stopPropagation());
  document.getElementById('vp').appendChild(b);
  return b;
}

async function toggleTilt() {
  if (!CAR.tilt && window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') { toast('Tilt permission denied'); return; } } catch (e) {}
  }
  CAR.tilt = !CAR.tilt; CAR.tiltV = 0;
  document.getElementById('carTilt').classList.toggle('on', CAR.tilt);
  toast(CAR.tilt ? 'Tilt steering on: tilt the phone left or right' : 'Touch steering: drag on the screen');
}

function buildUI() {
  const svgCam = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const svgTilt = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="18" rx="2" transform="rotate(20 12 12)"/></svg>';
  const svgRst = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v4h4"/></svg>';
  mkBtn('carCamB', 'cl1', svgCam, () => { CAR.view = (CAR.view + 1) % 3; toast(['Chase view', 'Close view', 'Hood view'][CAR.view]); }, 'Camera');
  mkBtn('carTilt', 'cl2', svgTilt, toggleTilt, 'Tilt steering');
  mkBtn('carRst', 'cr1', svgRst, () => { resetCar(); toast('Car reset to the start'); }, 'Reset car');
  const at = document.createElement('div');
  at.className = 'attr';
  at.innerHTML = 'Map: Overture Maps (ODbL), USGS 3DEP, Meta/WRI trees (CC BY 4.0), via topoexport.com';
  document.getElementById('vp').appendChild(at);
  const fi = document.createElement('input');
  fi.type = 'file'; fi.accept = '.zip,.json,.geojson'; fi.multiple = true; fi.style.display = 'none'; fi.id = 'mapFile';
  fi.addEventListener('change', () => { loadFiles(Array.from(fi.files)); fi.value = ''; });
  document.body.appendChild(fi);
}

/* ================= mode switch and sheet hooks ================= */
window.carMode = function (on) {
  const app = document.getElementById('app');
  if (on) {
    ensureScene();
    CAR.on = true; app.classList.add('car');
    if (CAR.prevAuto === null) { CAR.prevAuto = !!S.auto; }
    S.auto = true; S.launch = true;
    if (!CAR.world && !CAR.loading) startMap().then(() => toast('Press START, then gas. Drag on the screen to steer.'));
    else toast('Press START, then gas. Drag on the screen to steer.');
  } else {
    CAR.on = false; app.classList.remove('car'); S.fmax = 1e9; S.xF = 0; S.launch = false; CAR.ptr = 0;
    if (CAR.prevAuto !== null) { S.auto = CAR.prevAuto; CAR.prevAuto = null; }
  }
};

window.carRows = function () {
  const sel = CAR.custom ? 'custom' : 'def';
  return '<div class="row"><div>Map<small id="mapinfo">' + (CAR.mapName || 'Los Angeles (topoexport)') + '</small></div></div>' +
    '<div class="chips" style="margin:0 0 8px">' + chip('mapdef', 'Default map', sel === 'def', '') + chip('maploadbtn', 'Load my map…', sel === 'custom', '') + '</div>' +
    '<div class="note">Load the .zip you get from topoexport.com (roads, buildings, trees and contours become a drivable map). Maps stay saved on this phone.</div>' +
    '<div class="row"><div>Car colour</div></div><div class="chips" style="margin:0 0 8px">' +
    CAR_COLORS.map((c, i) => chip('carcol', c[0], CAR.color === i, String(i))).join('') + '</div>';
};

window.carAct = function (a, v) {
  if (a === 'carcol') { setCarColor(+v); return true; }
  if (a === 'mapdef') { localStorage.removeItem('v8sim.map'); idbDel('custom-map'); CAR.loading = false; if (CAR.on || CAR.scene) loadDefault(); return true; }
  if (a === 'maploadbtn') { document.getElementById('mapFile').click(); return true; }
  return false;
};

ensureScene();
bindInput();
buildUI();
})();