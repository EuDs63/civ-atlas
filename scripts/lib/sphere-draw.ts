/**
 * 球面世界的调试出图(只给脚本用,不进应用):按球面三角形铺一张等距圆柱主栅格(东西无缝、含两极),
 * 再按像素反投影出等距圆柱全图、正射地球仪。这是调试出图用的简化画法,应用里正式的铺像素、画风是另一回事。
 */
import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, statSync } from 'node:fs';
import type { Mesh } from '../../src/gen/mesh';
import { clamp } from '../../src/gen/util';

export type RGB = [number, number, number];
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * 按球面三角形铺像素:每个三角形只扫它经纬度包围盒里的像素,用三个"有向体积"判断像素的方向在不在三角形里,
 * 同时就是重心权重。跨 180° 经线的三角形把经度平移一圈再扫(像素列取模);含极点的三角形扫到极点、整圈经度。
 * 返回各字段的主栅格,另返回没被盖住的像素数(应为 0)。
 */
export function rasterizeSphere(mesh: Mesh, fields: ArrayLike<number>[], W: number, H: number): { out: Float32Array[]; holes: number } {
  const xyz = mesh.xyz!;
  const { triangles } = mesh;
  const lon = new Float64Array(mesh.n);
  const lat = new Float64Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    lon[i] = (mesh.x[i] / mesh.width) * 2 * Math.PI - Math.PI;
    lat[i] = Math.PI / 2 - (mesh.y[i] / mesh.height) * Math.PI;
  }
  const out = fields.map(() => new Float32Array(W * H));
  const filled = new Uint8Array(W * H);
  const cosLon = new Float64Array(W);
  const sinLon = new Float64Array(W);
  for (let px = 0; px < W; px++) {
    const l = ((px + 0.5) / W) * 2 * Math.PI - Math.PI;
    cosLon[px] = Math.cos(l);
    sinLon[px] = Math.sin(l);
  }
  const cosLat = new Float64Array(H);
  const sinLat = new Float64Array(H);
  for (let py = 0; py < H; py++) {
    const l = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
    cosLat[py] = Math.cos(l);
    sinLat[py] = Math.sin(l);
  }
  const F = fields.length;
  const toX = (l: number) => ((l + Math.PI) / (2 * Math.PI)) * W - 0.5;
  const toY = (l: number) => ((Math.PI / 2 - l) / Math.PI) * H - 0.5;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    const ax = xyz[3 * a], ay = xyz[3 * a + 1], az = xyz[3 * a + 2];
    const bx = xyz[3 * b], by = xyz[3 * b + 1], bz = xyz[3 * b + 2];
    const cx = xyz[3 * c], cy = xyz[3 * c + 1], cz = xyz[3 * c + 2];
    const n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx;
    const n2x = by * cz - bz * cy, n2y = bz * cx - bx * cz, n2z = bx * cy - by * cx;
    const n3x = cy * az - cz * ay, n3y = cz * ax - cx * az, n3z = cx * ay - cy * ax;
    const orient = Math.sign(ax * n2x + ay * n2y + az * n2z);
    const northIn = Math.sign(n1z) === orient && Math.sign(n2z) === orient && Math.sign(n3z) === orient;
    const southIn = Math.sign(n1z) === -orient && Math.sign(n2z) === -orient && Math.sign(n3z) === -orient;
    const mz = az + bz + cz;
    let y0: number;
    let y1: number;
    let xa: number;
    let xb: number;
    const la = [lat[a], lat[b], lat[c]];
    if (northIn) {
      y0 = 0;
      y1 = Math.ceil(toY(Math.min(...la))) + 1;
      xa = 0;
      xb = W - 1;
    } else if (southIn) {
      y0 = Math.floor(toY(Math.max(...la))) - 1;
      y1 = H - 1;
      xa = 0;
      xb = W - 1;
    } else if (Math.max(...la.map(Math.abs)) > (86 * Math.PI) / 180) {
      // 贴着极点的三角形(一条边从极点旁边擦过):经度范围不好算,整圈都扫;行扫到极点
      const north = la[0] > 0;
      y0 = north ? 0 : Math.floor(toY(Math.max(...la))) - 1;
      y1 = north ? Math.ceil(toY(Math.min(...la))) + 1 : H - 1;
      xa = 0;
      xb = W - 1;
    } else {
      y0 = Math.floor(toY(Math.max(...la))) - 1;
      y1 = Math.ceil(toY(Math.min(...la))) + 1;
      // 经度范围:三个经度在圆周上最短的那段覆盖弧(= 去掉最大的空隙);跨 180° 经线时 x 超过 W,取模
      const [l0, l1, l2] = [lon[a], lon[b], lon[c]].sort((u, v) => u - v);
      const g1 = l1 - l0;
      const g2 = l2 - l1;
      const g3 = l0 + 2 * Math.PI - l2;
      const [lo, hi] = g3 >= g1 && g3 >= g2 ? [l0, l2] : g1 >= g2 ? [l1, l0 + 2 * Math.PI] : [l2, l1 + 2 * Math.PI];
      xa = Math.floor(toX(lo)) - 1;
      xb = Math.ceil(toX(hi)) + 1;
    }
    y0 = Math.max(0, y0);
    y1 = Math.min(H - 1, y1);
    for (let py = y0; py <= y1; py++) {
      const cl = cosLat[py];
      const pz = sinLat[py];
      for (let xx = xa; xx <= xb; xx++) {
        const px = ((xx % W) + W) % W;
        const qx = cl * cosLon[px];
        const qy = cl * sinLon[px];
        if (qx * (ax + bx + cx) + qy * (ay + by + cy) + pz * mz <= 0) continue;
        const d1 = n1x * qx + n1y * qy + n1z * pz;
        const d2 = n2x * qx + n2y * qy + n2z * pz;
        const d3 = n3x * qx + n3y * qy + n3z * pz;
        const eps = -1e-12;
        const inside = (d1 >= eps && d2 >= eps && d3 >= eps) || (d1 <= -eps && d2 <= -eps && d3 <= -eps);
        if (!inside) continue;
        const s = d1 + d2 + d3;
        const wa = d2 / s;
        const wb = d3 / s;
        const wc = d1 / s;
        const o = py * W + px;
        for (let f = 0; f < F; f++) out[f][o] = wa * fields[f][a] + wb * fields[f][b] + wc * fields[f][c];
        filled[o] = 1;
      }
    }
  }
  let holes = 0;
  for (let i = 0; i < W * H; i++) if (!filled[i]) holes++;
  return { out, holes };
}

/** 主栅格:底色(RGB 交错)+ 当地东 / 北坡度(打光用) */
export interface Master {
  W: number;
  H: number;
  rgb: Float32Array;
  gE: Float32Array;
  gN: Float32Array;
}

/** 坡度:东西向一个像素的地面宽度 = cos(纬度) × 赤道处宽度;列下标取模 = 东西无缝 */
export function slopes(e: Float32Array, W: number, H: number, exag: (o: number) => number): { gE: Float32Array; gN: Float32Array } {
  const mPerPx = (40000 / W) * 1000;
  const gE = new Float32Array(W * H);
  const gN = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    const la = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
    const dx = 2 * mPerPx * Math.max(0.02, Math.cos(la));
    const up = Math.max(0, py - 1);
    const dn = Math.min(H - 1, py + 1);
    for (let px = 0; px < W; px++) {
      const l = px === 0 ? W - 1 : px - 1;
      const r = px === W - 1 ? 0 : px + 1;
      const o = py * W + px;
      const s = exag(o);
      gE[o] = (s * (e[py * W + r] - e[py * W + l])) / dx;
      gN[o] = (s * (e[up * W + px] - e[dn * W + px])) / (mPerPx * (dn - up));
    }
  }
  return { gE, gN };
}

// ---------------------------------------------------------------------------
// 投影:屏幕像素 → 经纬度(反投影取色)

export interface Projection {
  w: number;
  h: number;
  inv: (sx: number, sy: number) => [number, number] | null;
  fwd: (lon: number, lat: number) => [number, number] | null;
  globe?: { lon0: number; lat0: number; R: number; cx: number; cy: number };
}

const wrapLon = (l: number) => {
  let v = (l + Math.PI) % (2 * Math.PI);
  if (v < 0) v += 2 * Math.PI;
  return v - Math.PI;
};

export function equirect(w: number, lon0 = 0): Projection {
  const h = w / 2;
  return {
    w,
    h,
    inv: (sx, sy) => [wrapLon(((sx / w) * 2 - 1) * Math.PI + lon0), Math.PI / 2 - (sy / h) * Math.PI],
    fwd: (lon, lat) => [((wrapLon(lon - lon0) / Math.PI + 1) / 2) * w, ((Math.PI / 2 - lat) / Math.PI) * h],
  };
}

/** 正射(地球仪):中心经纬度朝向观察者;屏幕上方 = 中心处的北方 */
export function orthographic(size: number, lon0: number, lat0: number): Projection {
  const R = size * 0.46;
  const cx = size / 2;
  const cy = size / 2;
  const c = [Math.cos(lat0) * Math.cos(lon0), Math.cos(lat0) * Math.sin(lon0), Math.sin(lat0)];
  const e = [-Math.sin(lon0), Math.cos(lon0), 0];
  const nn = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  return {
    w: size,
    h: size,
    globe: { lon0, lat0, R, cx, cy },
    inv: (sx, sy) => {
      const u = (sx - cx) / R;
      const v = (cy - sy) / R;
      const r2 = u * u + v * v;
      if (r2 > 1) return null;
      const w = Math.sqrt(1 - r2);
      const x = u * e[0] + v * nn[0] + w * c[0];
      const y = u * e[1] + v * nn[1] + w * c[1];
      const z = u * e[2] + v * nn[2] + w * c[2];
      return [Math.atan2(y, x), Math.asin(clamp(z, -1, 1))];
    },
    fwd: (lon, lat) => {
      const p = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] < 0) return null;
      return [cx + R * (p[0] * e[0] + p[1] * e[1] + p[2] * e[2]), cy - R * (p[0] * nn[0] + p[1] * nn[1] + p[2] * nn[2])];
    },
  };
}

// ---------------------------------------------------------------------------
// 出图

export interface Image {
  w: number;
  h: number;
  data: Float32Array;
}

const BG: RGB = hex('#e9e4d8');
export const SPACE: RGB = hex('#0d1424');

/** 在主栅格上双线性取 底色 + 坡度(列取模 = 东西无缝) */
function sampleMaster(m: Master, lon: number, lat: number, out: Float64Array) {
  const fx = ((lon + Math.PI) / (2 * Math.PI)) * m.W - 0.5;
  const fy = ((Math.PI / 2 - lat) / Math.PI) * m.H - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const W = m.W;
  const xa = ((x0 % W) + W) % W;
  const xb = (xa + 1) % W;
  const ya = clamp(y0, 0, m.H - 1);
  const yb = clamp(y0 + 1, 0, m.H - 1);
  const i00 = ya * W + xa;
  const i10 = ya * W + xb;
  const i01 = yb * W + xa;
  const i11 = yb * W + xb;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  for (let k = 0; k < 3; k++) out[k] = m.rgb[3 * i00 + k] * w00 + m.rgb[3 * i10 + k] * w10 + m.rgb[3 * i01 + k] * w01 + m.rgb[3 * i11 + k] * w11;
  out[3] = m.gE[i00] * w00 + m.gE[i10] * w10 + m.gE[i01] * w01 + m.gE[i11] * w11;
  out[4] = m.gN[i00] * w00 + m.gN[i10] * w10 + m.gN[i01] * w01 + m.gN[i11] * w11;
}

/** 按投影出图:平面图光从西北来;地球仪光在屏幕上固定、按 3D 法向打光 */
export function renderProjection(m: Master, proj: Projection, graticule = true): Image {
  const { w, h } = proj;
  const data = new Float32Array(w * h * 3);
  const s = new Float64Array(5);
  const Lx = -0.55;
  const Ly = 0.55;
  const Lz = 0.63;
  const g = proj.globe;
  let C: number[] = [0, 0, 0];
  let Lw: number[] = [0, 0, 0];
  if (g) {
    C = [Math.cos(g.lat0) * Math.cos(g.lon0), Math.cos(g.lat0) * Math.sin(g.lon0), Math.sin(g.lat0)];
    const E = [-Math.sin(g.lon0), Math.cos(g.lon0), 0];
    const Nn = [C[1] * E[2] - C[2] * E[1], C[2] * E[0] - C[0] * E[2], C[0] * E[1] - C[1] * E[0]];
    const lv = [-0.45, 0.5, 0.74];
    const ll = Math.hypot(lv[0], lv[1], lv[2]);
    Lw = [0, 1, 2].map((k) => (lv[0] * E[k] + lv[1] * Nn[k] + lv[2] * C[k]) / ll);
  }
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const o = 3 * (sy * w + sx);
      const ll = proj.inv(sx + 0.5, sy + 0.5);
      if (!ll) {
        let c = g ? SPACE : BG;
        if (g) {
          const r = Math.hypot(sx + 0.5 - g.cx, sy + 0.5 - g.cy) / g.R;
          c = mix(c, hex('#8fb8e8'), clamp(Math.exp(-(r - 1) * 28) * 0.55, 0, 1));
        }
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        continue;
      }
      const [lon, lat] = ll;
      sampleMaster(m, lon, lat, s);
      let shade: number;
      if (!g) {
        const nx = -s[3];
        const ny = -s[4];
        const nl = Math.sqrt(nx * nx + ny * ny + 1);
        shade = clamp(0.35 + 0.65 * ((nx * Lx + ny * Ly + Lz) / nl / Lz), 0.45, 1.25);
      } else {
        const cl = Math.cos(lat);
        const px = cl * Math.cos(lon);
        const py = cl * Math.sin(lon);
        const pz = Math.sin(lat);
        const ex = -Math.sin(lon);
        const ey = Math.cos(lon);
        const nx0 = -Math.sin(lat) * Math.cos(lon);
        const ny0 = -Math.sin(lat) * Math.sin(lon);
        const nz0 = cl;
        let Nx = px - s[3] * ex - s[4] * nx0;
        let Ny = py - s[3] * ey - s[4] * ny0;
        let Nz = pz - s[4] * nz0;
        const nl = Math.sqrt(Nx * Nx + Ny * Ny + Nz * Nz);
        Nx /= nl;
        Ny /= nl;
        Nz /= nl;
        const flat = px * Lw[0] + py * Lw[1] + pz * Lw[2];
        const bump = Nx * Lw[0] + Ny * Lw[1] + Nz * Lw[2];
        const relief = clamp(1 + 1.6 * (bump - flat), 0.5, 1.4);
        const view = px * C[0] + py * C[1] + pz * C[2];
        shade = relief * (0.5 + 0.5 * clamp(flat, 0, 1)) * (0.82 + 0.18 * view);
      }
      data[o] = clamp(s[0] * shade, 0, 255);
      data[o + 1] = clamp(s[1] * shade, 0, 255);
      data[o + 2] = clamp(s[2] * shade, 0, 255);
    }
  }
  if (graticule) drawGraticule({ w, h, data }, proj);
  return { w, h, data };
}

/** 经纬网:每 30° 一条(赤道稍亮) */
function drawGraticule(img: Image, proj: Projection) {
  const step = (0.04 * Math.PI) / 180;
  const plot = (lon: number, lat: number, a: number) => {
    const p = proj.fwd(lon, lat);
    if (!p) return;
    const x = Math.floor(p[0]);
    const y = Math.floor(p[1]);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    const o = 3 * (y * img.w + x);
    for (let k = 0; k < 3; k++) img.data[o + k] += (255 - img.data[o + k]) * a;
  };
  const a = 0.22;
  for (let d = -150; d <= 180; d += 30) {
    const lon = (d * Math.PI) / 180;
    for (let lat = -Math.PI / 2; lat <= Math.PI / 2; lat += step) plot(lon, lat, a);
  }
  for (let d = -60; d <= 60; d += 30) {
    const lat = (d * Math.PI) / 180;
    for (let lon = -Math.PI; lon < Math.PI; lon += step) plot(lon, lat, d === 0 ? a * 1.4 : a);
  }
}

/** 在图上画一条经纬度折线(每段按屏幕距离加密;投影里看不见的点断开) */
export function drawPath(img: Image, proj: Projection, pts: [number, number][], color: RGB, width: number, alpha = 1) {
  const dot = (x: number, y: number) => {
    const r = width / 2;
    for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++)
      for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
        if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
        const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
        const cov = clamp(r + 0.5 - d, 0, 1) * alpha;
        if (cov <= 0) continue;
        const o = 3 * (yy * img.w + xx);
        for (let k = 0; k < 3; k++) img.data[o + k] += (color[k] - img.data[o + k]) * cov;
      }
  };
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = proj.fwd(pts[k][0], pts[k][1]);
    const b = proj.fwd(pts[k + 1][0], pts[k + 1][1]);
    if (!a || !b) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > proj.w / 3) continue; // 跨过图边(等距圆柱的 180° 经线)的一段不画
    const m = Math.max(1, Math.ceil(L / 0.7));
    for (let t = 0; t <= m; t++) dot(a[0] + ((b[0] - a[0]) * t) / m, a[1] + ((b[1] - a[1]) * t) / m);
  }
}

export function downsample2(img: Image): Image {
  const w = img.w >> 1;
  const h = img.h >> 1;
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 3; k++) {
        const a = 3 * (2 * y * img.w + 2 * x) + k;
        const b = a + 3 * img.w;
        data[3 * (y * w + x) + k] = (img.data[a] + img.data[a + 3] + img.data[b] + img.data[b + 3]) / 4;
      }
  return { w, h, data };
}

/** 横着拼几张同样高的图 */
export function hstack(imgs: Image[], bg: RGB): Image {
  const w = imgs.reduce((s, i) => s + i.w, 0);
  const h = Math.max(...imgs.map((i) => i.h));
  const data = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(bg, 3 * i);
  let ox = 0;
  for (const im of imgs) {
    for (let y = 0; y < im.h; y++) data.set(im.data.subarray(3 * y * im.w, 3 * (y + 1) * im.w), 3 * (y * w + ox));
    ox += im.w;
  }
  return { w, h, data };
}

/** 存成 JPEG(先写 PNG,再用 macOS 的 sips 转成质量 80、长边 ≤ maxSide 的 JPEG,删掉 PNG)。返回 JPEG 大小(KB) */
export function saveJpeg(img: Image, file: string, maxSide = 1400): number {
  const png = new PNG({ width: img.w, height: img.h });
  for (let i = 0; i < img.w * img.h; i++) {
    png.data[4 * i] = Math.round(img.data[3 * i]);
    png.data[4 * i + 1] = Math.round(img.data[3 * i + 1]);
    png.data[4 * i + 2] = Math.round(img.data[3 * i + 2]);
    png.data[4 * i + 3] = 255;
  }
  const tmp = file.replace(/\.jpe?g$/, '') + '.png';
  writeFileSync(tmp, PNG.sync.write(png));
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(maxSide), tmp, '--out', file], { stdio: 'ignore' });
  unlinkSync(tmp);
  return Math.round(statSync(file).size / 1024);
}
