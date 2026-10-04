/**
 * 世界的调试出图(不进应用;和应用里的铺像素、画风分开写的一套简单画法,看地形、两极、板块用):
 *
 *   npx tsx scripts/sphere-snaps.ts 7 2024 --out snaps/sphere-world      # 每个种子出三张 JPEG
 *   npx tsx scripts/sphere-snaps.ts 7 --cells 80000
 *
 * 每个种子:
 *   - <seed>-map.jpg:等距圆柱全图(主图,东西无缝、上下边是南北极):群落底色 + 晕渲 + 海冰 + 河流 + 30° 经纬网
 *   - <seed>-globes.jpg:正射地球仪四个角度(正面、背面(180° 经线在正中)、北极、南极)
 *   - <seed>-plates.jpg:板块图:每个板块一种颜色,汇聚边界红、离散边界蓝,箭头 = 板块在当地的漂移速度(欧拉轴转动)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateWorld } from '../src/gen/world';
import { BIOMES, Biome } from '../src/gen/biomes';
import { geometryOf } from '../src/gen/geometry';
import { clamp, smoothstep } from '../src/gen/util';
import {
  downsample2,
  drawPath,
  equirect,
  hex,
  hstack,
  mix,
  orthographic,
  rasterizeSphere,
  renderProjection,
  saveJpeg,
  slopes,
  SPACE,
  type Image,
  type Master,
  type Projection,
  type RGB,
} from './lib/sphere-draw';

const args = process.argv.slice(2);
const argOf = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = argOf('--out') ?? 'snaps/sphere-world';
const CELLS = argOf('--cells') ? Number(argOf('--cells')) : undefined;
const seeds = args.filter((a, i) => /^-?\d+$/.test(a) && !['--out', '--cells'].includes(args[i - 1])).map(Number);
if (!seeds.length) seeds.push(7);
mkdirSync(OUT, { recursive: true });

const W = 2048;
const H = 1024;
const OCEAN: [number, RGB][] = [
  [0, hex('#4f93bd')],
  [-90, hex('#3677aa')],
  [-500, hex('#275b92')],
  [-2400, hex('#1b4276')],
  [-5000, hex('#112c55')],
  [-8000, hex('#0a1d3d')],
];
function oceanColor(e: number): RGB {
  for (let i = 0; i < OCEAN.length - 1; i++) {
    const [e0, c0] = OCEAN[i];
    const [e1, c1] = OCEAN[i + 1];
    if (e >= e1) return mix(c0, c1, clamp((e0 - e) / (e0 - e1), 0, 1));
  }
  return OCEAN[OCEAN.length - 1][1];
}
const ICE: RGB = hex('#eef3f6');
const LAKE: RGB = hex('#3b739a');
const RIVER: RGB = hex('#2f6390');

for (const seed of seeds) {
  const t0 = performance.now();
  const w = generateWorld({ seed, ...(CELLS ? { cells: CELLS } : {}) } as Parameters<typeof generateWorld>[0]);
  const t1 = performance.now();
  const { mesh, water, elevation, seaIce, biome } = w;
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);

  // ---- 每个地块的底色:陆地 / 海面两套颜色分开插值,按像素的海陆取一套(海岸线清楚) ----
  const se = new Float32Array(n);
  const lakeF = new Float32Array(n);
  const landC = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const seaC = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const own = (i: number): RGB | null => {
    if (water[i] === 0) return BIOMES[biome[i]].real;
    return null;
  };
  const seaOwn = (i: number): RGB | null => {
    if (water[i] !== 1) return null;
    const ice = smoothstep(0.25, 0.75, seaIce[i]);
    return mix(oceanColor(elevation[i]), mix(ICE, hex('#c9d7e2'), 0.3 * (1 - ice)), ice);
  };
  for (let i = 0; i < n; i++) {
    se[i] = water[i] === 1 ? elevation[i] : water[i] === 2 ? 5 : Math.max(5, elevation[i]);
    lakeF[i] = water[i] === 2 ? 1 : 0;
    for (const [get, out, fallback] of [
      [own, landC, hex('#b9ad86')],
      [seaOwn, seaC, OCEAN[0][1]],
    ] as const) {
      let c = get(i);
      if (!c) {
        // 没有自己的颜色:取相邻那一类地块的平均
        let s0 = 0, s1 = 0, s2 = 0, k0 = 0;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const cj = get(adj[k]);
          if (!cj) continue;
          s0 += cj[0];
          s1 += cj[1];
          s2 += cj[2];
          k0++;
        }
        c = k0 ? [s0 / k0, s1 / k0, s2 / k0] : fallback;
      }
      out[0][i] = c[0];
      out[1][i] = c[1];
      out[2][i] = c[2];
    }
  }
  const t2 = performance.now();
  const { out: F, holes } = rasterizeSphere(mesh, [se, lakeF, ...landC, ...seaC], W, H);
  const [E, LK, lr, lg, lb, sr, sg, sb] = F;
  const rgb = new Float32Array(W * H * 3);
  const isLand = new Uint8Array(W * H);
  for (let o = 0; o < W * H; o++) {
    let c: RGB;
    if (LK[o] > 0.5) c = LAKE;
    else if (E[o] > 0) {
      c = [lr[o], lg[o], lb[o]];
      isLand[o] = 1;
    } else c = [sr[o], sg[o], sb[o]];
    rgb.set(c, 3 * o);
  }
  const { gE, gN } = slopes(E, W, H, (o) => (isLand[o] ? 22 : 22 * 0.18));
  const master: Master = { W, H, rgb, gE, gN };
  const t3 = performance.now();

  // ---- 河流:按地块链取点(链头 / 链尾是湖、海时取和相邻地块的中点) ----
  const rivers: { pts: [number, number][]; w: number }[] = [];
  const m = [0, 0];
  for (const r of w.rivers) {
    const cells = r.cells!;
    const pts: [number, number][] = [];
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      const end = k === 0 ? cells[1] : k === cells.length - 1 ? cells[k - 1] : -1;
      if (end >= 0 && water[c] !== 0) geo.mid(c, end, m);
      else {
        m[0] = mesh.x[c];
        m[1] = mesh.y[c];
      }
      pts.push([(m[0] / W) * 2 * Math.PI - Math.PI, Math.PI / 2 - (m[1] / H) * Math.PI]);
    }
    const peak = r.pts[r.pts.length - 1];
    rivers.push({ pts, w: clamp(0.5 + 0.45 * Math.sqrt(peak / w.riverThreshold), 0.6, 3.2) });
  }
  const withRivers = (img: Image, proj: Projection, scale: number) => {
    for (const r of rivers) drawPath(img, proj, r.pts, RIVER, r.w * scale, 0.9);
    return img;
  };

  // ---- 主图 ----
  const mapProj = equirect(W * 2);
  const map = downsample2(withRivers(renderProjection(master, mapProj), mapProj, 2));
  const kb1 = saveJpeg(map, join(OUT, `${seed}-map.jpg`));

  // ---- 地球仪四个角度 ----
  const deg = Math.PI / 180;
  const views: [number, number][] = [
    [20, 20],
    [180, -10],
    [-40, 72],
    [60, -68],
  ];
  const globes = views.map(([lo, la]) => {
    const p = orthographic(1400, lo * deg, la * deg);
    return downsample2(withRivers(renderProjection(master, p), p, 1.6));
  });
  // 两行:上 正面 / 背面,下 北极 / 南极
  const top = hstack([globes[0], globes[1]], SPACE);
  const bottom = hstack([globes[2], globes[3]], SPACE);
  const grid: Image = { w: top.w, h: top.h + bottom.h, data: new Float32Array(top.w * (top.h + bottom.h) * 3) };
  grid.data.set(top.data, 0);
  grid.data.set(bottom.data, top.data.length);
  const kb2 = saveJpeg(grid, join(OUT, `${seed}-globes.jpg`));

  // ---- 板块图、降水图 ----
  const kb3 = savePlates(seed);
  const kb4 = saveRain(seed);

  const land = water.reduce((s, v) => s + (v === 0 ? 1 : 0), 0);
  console.log(
    `seed ${seed}:${n} 块,生成 ${Math.round(t1 - t0)}ms,铺主栅格 ${Math.round(t3 - t2)}ms(漏洞 ${holes} 像素),陆地 ${((100 * land) / n).toFixed(1)}%,` +
      `河 ${w.rivers.length} 条 → ${seed}-map.jpg ${kb1}KB · ${seed}-globes.jpg ${kb2}KB · ${seed}-plates.jpg ${kb3}KB · ${seed}-rain.jpg ${kb4}KB`,
  );

  /** 降水图(陆地和海面都画;对数色阶:干 → 湿 = 棕 → 绿 → 蓝),红色竖线 = 每条风带的切口(顺风排序从这里切开) */
  function saveRain(seed: number): number {
    const stops: [number, RGB][] = [
      [0, hex('#8c5a2b')],
      [0.25, hex('#d9b26a')],
      [0.5, hex('#9cc46a')],
      [0.75, hex('#2f8f5b')],
      [1, hex('#1f4fa0')],
    ];
    const col = (v: number): RGB => {
      for (let k = 0; k + 1 < stops.length; k++) if (v <= stops[k + 1][0]) return mix(stops[k][1], stops[k + 1][1], (v - stops[k][0]) / (stops[k + 1][0] - stops[k][0]));
      return stops[stops.length - 1][1];
    };
    const fr = new Float32Array(n);
    const fg = new Float32Array(n);
    const fb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = clamp(Math.log10(Math.max(50, w.precipitation[i]) / 50) / Math.log10(5000 / 50), 0, 1);
      let c = col(v);
      if (water[i] === 1) c = mix(c, [255, 255, 255], 0.35);
      fr[i] = c[0];
      fg[i] = c[1];
      fb[i] = c[2];
    }
    const { out } = rasterizeSphere(mesh, [fr, fg, fb, se], W, H);
    const rgb2 = new Float32Array(W * H * 3);
    for (let o = 0; o < W * H; o++) rgb2.set([out[0][o], out[1][o], out[2][o]], 3 * o);
    const s = slopes(out[3], W, H, () => 0);
    const proj = equirect(W);
    const img = renderProjection({ W, H, rgb: rgb2, gE: s.gE, gN: s.gN }, proj);
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const o = py * W + px;
        const r = py * W + ((px + 1) % W);
        const d = Math.min(H - 1, py + 1) * W + px;
        if (out[3][o] > 0 !== out[3][r] > 0 || out[3][o] > 0 !== out[3][d] > 0) for (let k = 0; k < 3; k++) img.data[3 * o + k] *= 0.3;
      }
    const cuts = geo.windCuts(water)!;
    for (let b = 0; b < cuts.length; b++) {
      const lon = (cuts[b] / W) * 2 * Math.PI - Math.PI;
      const la0 = Math.PI / 2 - (b / cuts.length) * Math.PI;
      const la1 = Math.PI / 2 - ((b + 1) / cuts.length) * Math.PI;
      drawPath(img, proj, [[lon, la0], [lon, la1]], [220, 30, 30], 2, 0.8);
    }
    return saveJpeg(img, join(OUT, `${seed}-rain.jpg`));
  }

  function savePlates(seed: number): number {
    const { tect } = w;
    const P = tect.plateCount;
    const pc: RGB[] = [];
    for (let k = 0; k < P; k++) {
      const h = (k * 0.618034) % 1;
      const a = h * 2 * Math.PI;
      pc.push([150 + 70 * Math.cos(a), 150 + 70 * Math.cos(a - 2.1), 150 + 70 * Math.cos(a + 2.1)]);
    }
    const fr = new Float32Array(n);
    const fg = new Float32Array(n);
    const fb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let c = pc[tect.plate[i]];
      if (tect.plateContinental[tect.plate[i]]) c = mix(c, [120, 100, 70], 0.25);
      const cv = tect.convergence[i];
      if (cv > 0.25) c = mix(c, [205, 40, 30], clamp(cv, 0.4, 1));
      else if (cv < -0.25) c = mix(c, [30, 70, 210], clamp(-cv, 0.4, 1));
      if (water[i] !== 1) c = mix(c, [60, 50, 40], 0.18);
      fr[i] = c[0];
      fg[i] = c[1];
      fb[i] = c[2];
    }
    const { out } = rasterizeSphere(mesh, [fr, fg, fb, se], W, H);
    const prgb = new Float32Array(W * H * 3);
    for (let o = 0; o < W * H; o++) {
      prgb[3 * o] = out[0][o];
      prgb[3 * o + 1] = out[1][o];
      prgb[3 * o + 2] = out[2][o];
    }
    const s = slopes(out[3], W, H, () => 4);
    const proj = equirect(W);
    const img = renderProjection({ W, H, rgb: prgb, gE: s.gE, gN: s.gN }, proj);
    // 海岸线
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const o = py * W + px;
        const r = py * W + ((px + 1) % W);
        const d = Math.min(H - 1, py + 1) * W + px;
        if (out[3][o] > 0 !== out[3][r] > 0 || out[3][o] > 0 !== out[3][d] > 0) for (let k = 0; k < 3; k++) img.data[3 * o + k] *= 0.35;
      }
    // 速度箭头:纬度每 9°、经度按 cos(纬度) 加宽,在最近的地块上取 ω × p(东、南分量)
    const om = tect.plateOmega;
    const p = mesh.xyz!;
    for (let la = -81; la <= 81; la += 9) {
      const step = 9 / Math.max(0.15, Math.cos(la * deg));
      for (let lo = -180 + step / 2; lo < 180; lo += step) {
        const x = ((lo + 180) / 360) * W;
        const y = ((90 - la) / 180) * H;
        const i = geo.nearest(x, y, 0);
        const k = tect.plate[i];
        const [px, py, pz] = [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
        const v = [om[3 * k + 1] * pz - om[3 * k + 2] * py, om[3 * k + 2] * px - om[3 * k] * pz, om[3 * k] * py - om[3 * k + 1] * px];
        const lon = lo * deg;
        const lat = la * deg;
        const ve = -Math.sin(lon) * v[0] + Math.cos(lon) * v[1];
        const vn = -Math.sin(lat) * Math.cos(lon) * v[0] - Math.sin(lat) * Math.sin(lon) * v[1] + Math.cos(lat) * v[2];
        // 箭头长度:速度 1 ≈ 6°(沿地面),画成经纬度上的一段
        const L = 6 * deg;
        const dLon = (ve * L) / Math.max(0.15, Math.cos(lat));
        const dLat = vn * L;
        const a: [number, number] = [lon, lat];
        const b: [number, number] = [lon + dLon, lat + dLat];
        drawPath(img, proj, [a, b], [20, 20, 20], 1.6, 0.85);
        drawPath(img, proj, [b, b], [20, 20, 20], 3.4, 0.85);
      }
    }
    return saveJpeg(img, join(OUT, `${seed}-plates.jpg`));
  }
}
