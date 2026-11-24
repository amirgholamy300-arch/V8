/* topo.js - converts a topoexport.com export (GeoJSON layers, metres) into a compact map for the car mode.
   Works in the browser and in node. Layers: frame, contours, roads, buildings, trees, green, water, waterLines. */
(function (root) {
'use strict';

function b64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'), u = new Uint8Array(b.length); u.set(b); return u; }
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const out = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

/* minimal zip reader: returns { name: Uint8Array } for .geojson / .json entries only */
async function readZip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('Not a zip file');
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const dec = new TextDecoder(), out = {};
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl;
    if (!/\.(geojson|json)$/i.test(name)) continue;
    const lnl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true);
    const start = lo + 30 + lnl + lel, data = u8.subarray(start, start + csz);
    if (method === 0) out[name] = data;
    else if (method === 8) out[name] = await inflateRaw(data);
  }
  return out;
}

/* decide which layer a GeoJSON file is */
function classify(name, json) {
  const n = String(name).toLowerCase();
  if (n.indexOf('frame') >= 0) return 'frame';
  if (n.indexOf('building') >= 0) return 'buildings';
  if (n.indexOf('road') >= 0) return 'roads';
  if (n.indexOf('tree') >= 0) return 'trees';
  if (n.indexOf('contour') >= 0) return 'contours';
  if (n.indexOf('green') >= 0) return 'green';
  if (n.indexOf('water') >= 0) {
    const f = json && json.features && json.features[0];
    const t = f && f.geometry && f.geometry.type;
    return (t === 'Polygon' || t === 'MultiPolygon') ? 'water' : 'waterLines';
  }
  return null;
}

const r1 = v => Math.round(v * 10) / 10;

function convert(L, opts) {
  opts = opts || {};
  const feats = k => (L[k] && L[k].features) || [];
  const lines = g => !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  const polys = g => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];

  /* ---- extent ---- */
  let mnx = 1e18, mny = 1e18, mxx = -1e18, mxy = -1e18;
  const ext = (x, y) => { if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; };
  const fr = feats('frame');
  if (fr.length) {
    lines(fr[0].geometry).forEach(l => l.forEach(c => ext(c[0], c[1])));
    polys(fr[0].geometry).forEach(pl => pl[0].forEach(c => ext(c[0], c[1])));
  }
  if (!(mnx < mxx)) {
    ['roads', 'buildings', 'contours'].forEach(k => feats(k).forEach(f => {
      lines(f.geometry).forEach(l => l.forEach(c => ext(c[0], c[1])));
      polys(f.geometry).forEach(pl => pl[0].forEach(c => ext(c[0], c[1])));
    }));
  }
  if (!(mnx < mxx)) throw new Error('No usable map layers found');
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, W = mxx - mnx, H = mxy - mny;
  const lx = X => X - cx, lz = Y => -(Y - cy);          /* x = east, z = south */

  /* ---- terrain from contour lines ---- */
  const N = opts.n || 256;
  const step = Math.max(W, H) / N;
  const nx = Math.round(W / step) + 1, nz = Math.round(H / step) + 1;
  const PX = [], PZ = [], PF = [], ELE = [];
  feats('contours').forEach(f => {
    const e = parseFloat(f.properties && f.properties.elevation);
    if (!isFinite(e)) return;
    lines(f.geometry).forEach(l => {
      const id = ELE.length; ELE.push(e);
      for (let i = 0; i < l.length; i++) {
        const ax = lx(l[i][0]), az = lz(l[i][1]);
        PX.push(ax); PZ.push(az); PF.push(id);
        if (i + 1 < l.length) {
          const bx = lx(l[i + 1][0]), bz = lz(l[i + 1][1]), d = Math.hypot(bx - ax, bz - az), k = Math.ceil(d / 3);
          for (let s = 1; s < k; s++) { PX.push(ax + (bx - ax) * s / k); PZ.push(az + (bz - az) * s / k); PF.push(id); }
        }
      }
    });
  });
  let hmin = 0, heights = new Float32Array(nx * nz);
  if (ELE.length) {
    hmin = Math.min.apply(null, ELE);
    const cs = Math.max(15, step * 4), gw = Math.ceil(W / cs) + 3, gh = Math.ceil(H / cs) + 3;
    const ox = -W / 2 - cs, oz = -H / 2 - cs, cells = new Array(gw * gh);
    for (let k = 0; k < PX.length; k++) {
      const ci = Math.min(gw - 1, Math.max(0, Math.floor((PX[k] - ox) / cs))), cj = Math.min(gh - 1, Math.max(0, Math.floor((PZ[k] - oz) / cs)));
      (cells[cj * gw + ci] || (cells[cj * gw + ci] = [])).push(k);
    }
    const maxR = Math.ceil(400 / cs);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = -W / 2 + i * step, z = -H / 2 + j * step;
        const ci = Math.min(gw - 1, Math.max(0, Math.floor((x - ox) / cs))), cj = Math.min(gh - 1, Math.max(0, Math.floor((z - oz) / cs)));
        const best = new Map();
        for (let r = 0; r <= maxR; r++) {
          for (let dj = -r; dj <= r; dj++) {
            for (let di = -r; di <= r; di++) {
              if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
              const ii = ci + di, jj = cj + dj;
              if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
              const c = cells[jj * gw + ii];
              if (!c) continue;
              for (let q = 0; q < c.length; q++) {
                const k = c[q], dx = PX[k] - x, dz = PZ[k] - z, d2 = dx * dx + dz * dz, f = PF[k], o = best.get(f);
                if (o === undefined || d2 < o) best.set(f, d2);
              }
            }
          }
          if (best.size >= 3) {
            const ds = Array.from(best.values()).sort((a, b) => a - b);
            if (Math.sqrt(ds[2]) <= r * cs) break;
          }
        }
        let h = hmin;
        if (best.size) {
          const arr = Array.from(best.entries()).sort((a, b) => a[1] - b[1]).slice(0, 4);
          let sw = 0, sh = 0;
          arr.forEach(a => { const w = 1 / Math.max(0.5, Math.sqrt(a[1])); sw += w; sh += w * ELE[a[0]]; });
          h = sh / sw;
        }
        heights[j * nx + i] = h;
      }
    }
    /* two smoothing passes so contour steps do not feel like bumps */
    for (let pass = 0; pass < 2; pass++) {
      const t = new Float32Array(heights);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          s += t[jj * nx + ii]; c++;
        }
        heights[j * nx + i] = s / c;
      }
    }
    hmin = Infinity; for (let i = 0; i < heights.length; i++) if (heights[i] < hmin) hmin = heights[i];
  }
  const u16 = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) u16[i] = Math.max(0, Math.min(65535, Math.round((heights[i] - hmin) * 20)));
  const hB64 = b64(new Uint8Array(u16.buffer));

  /* ---- roads ---- */
  const roads = [];
  feats('roads').forEach(f => {
    const w = parseFloat(f.properties && f.properties.width) || 3.5, t = (f.properties && f.properties.type) || 'Minor';
    lines(f.geometry).forEach(l => {
      if (l.length < 2) return;
      /* keep only the parts that lie inside the map frame */
      let p = [];
      const flush = () => { if (p.length >= 4) roads.push({ w: w, t: t, p: p }); p = []; };
      l.forEach(c => {
        const x = lx(c[0]), z = lz(c[1]);
        if (Math.abs(x) <= W / 2 - 3 && Math.abs(z) <= H / 2 - 3) p.push(r1(x), r1(z)); else flush();
      });
      flush();
    });
  });

  /* ---- buildings ---- */
  const bld = [];
  feats('buildings').forEach(f => {
    const h = Math.max(3, parseFloat(f.properties && f.properties.height) || 5);
    polys(f.geometry).forEach(pl => {
      let ring = pl[0];
      if (!ring || ring.length < 4) return;
      ring = ring.slice(0, ring.length - 1);
      const p = []; let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        area += (lx(a[0]) * lz(b[1]) - lx(b[0]) * lz(a[1])) / 2;
        p.push(r1(lx(a[0])), r1(lz(a[1])));
      }
      if (Math.abs(area) < 4) return;
      bld.push({ h: r1(h), p: p });
    });
  });

  /* ---- trees: keep them off roads and out of buildings ---- */
  const RC = 20, rh = new Map();
  const rkey = (i, j) => i * 100003 + j;
  roads.forEach(r => {
    const hw = Math.max(r.w * 1.25, 4.5) / 2 + 1.5;
    for (let i = 2; i < r.p.length; i += 2) {
      const x1 = r.p[i - 2], z1 = r.p[i - 1], x2 = r.p[i], z2 = r.p[i + 1], seg = [x1, z1, x2, z2, hw];
      const i0 = Math.floor((Math.min(x1, x2) - hw) / RC), i1 = Math.floor((Math.max(x1, x2) + hw) / RC);
      const j0 = Math.floor((Math.min(z1, z2) - hw) / RC), j1 = Math.floor((Math.max(z1, z2) + hw) / RC);
      for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) { const k = rkey(a, b); (rh.get(k) || rh.set(k, []).get(k)).push(seg); }
    }
  });
  function nearRoad(x, z) {
    const c = rh.get(rkey(Math.floor(x / RC), Math.floor(z / RC)));
    if (!c) return false;
    for (let q = 0; q < c.length; q++) {
      const s = c[q], dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - s[0]) * dx + (z - s[1]) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - (s[0] + dx * t), z - (s[1] + dz * t)) < s[4]) return true;
    }
    return false;
  }
  const BC = 30, bh = new Map();
  bld.forEach((b, id) => {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < b.p.length; i += 2) { x0 = Math.min(x0, b.p[i]); x1 = Math.max(x1, b.p[i]); z0 = Math.min(z0, b.p[i + 1]); z1 = Math.max(z1, b.p[i + 1]); }
    b.bb = [x0, z0, x1, z1];
    for (let a = Math.floor(x0 / BC); a <= Math.floor(x1 / BC); a++) for (let c = Math.floor(z0 / BC); c <= Math.floor(z1 / BC); c++) { const k = rkey(a, c); (bh.get(k) || bh.set(k, []).get(k)).push(id); }
  });
  function inPoly(p, x, z) {
    let ins = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  }
  function inBuilding(x, z) {
    const c = bh.get(rkey(Math.floor(x / BC), Math.floor(z / BC)));
    if (!c) return false;
    for (let q = 0; q < c.length; q++) { const b = bld[c[q]], bb = b.bb; if (x >= bb[0] - 1 && x <= bb[2] + 1 && z >= bb[1] - 1 && z <= bb[3] + 1 && inPoly(b.p, x, z)) return true; }
    return false;
  }
  const trees = [];
  feats('trees').forEach(f => {
    const g = f.geometry; if (!g || g.type !== 'Point') return;
    const x = lx(g.coordinates[0]), z = lz(g.coordinates[1]);
    if (Math.abs(x) > W / 2 || Math.abs(z) > H / 2) return;
    if (nearRoad(x, z) || inBuilding(x, z)) return;
    const h = Math.min(20, Math.max(3, parseFloat(f.properties && f.properties.height) || 8));
    const c = Math.min(9, Math.max(2, parseFloat(f.properties && f.properties.crown_diameter) || 4));
    trees.push(Math.round(x * 10), Math.round(z * 10), Math.round(h * 10), Math.round(c * 10));
  });
  bld.forEach(b => { delete b.bb; });

  /* ---- green areas, water ---- */
  const ringsOf = k => { const o = []; feats(k).forEach(f => polys(f.geometry).forEach(pl => {
    const ring = pl[0]; if (!ring || ring.length < 4) return;
    const p = []; for (let i = 0; i < ring.length - 1; i++) p.push(r1(lx(ring[i][0])), r1(lz(ring[i][1]))); o.push(p);
  })); return o; };
  const green = ringsOf('green'), water = ringsOf('water');
  const wl = [];
  feats('waterLines').forEach(f => lines(f.geometry).forEach(l => { const p = []; l.forEach(c => p.push(r1(lx(c[0])), r1(lz(c[1])))); if (p.length >= 4) wl.push(p); }));

  /* ---- spawn: start on the longest major road ---- */
  const plen = p => { let s = 0; for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return s; };
  let pick = null, pl = -1;
  roads.forEach(r => { const l = plen(r.p) * (r.t === 'Major' ? 3 : 1); if (l > pl) { pl = l; pick = r; } });
  let spawn = { x: 0, z: 0, th: 0 };
  if (pick) {
    const k = Math.max(0, Math.min(pick.p.length / 2 - 2, Math.floor(pick.p.length / 2 * 0.15))) * 2;
    const dx = pick.p[k + 2] - pick.p[k], dz = pick.p[k + 3] - pick.p[k + 1];
    spawn = { x: pick.p[k], z: pick.p[k + 1], th: Math.atan2(dx, dz) };
  }

  return {
    v: 1, name: opts.name || 'Custom map', W: W, H: H, nx: nx, nz: nz, step: step, hmin: hmin, h: hB64,
    roads: roads, bld: bld, trees: trees, green: green, water: water, wl: wl, spawn: spawn
  };
}

const API = { b64: b64, unb64: unb64, readZip: readZip, classify: classify, convert: convert };
root.Topo = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);