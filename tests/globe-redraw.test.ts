/**
 * 地球仪按投影重画:
 *   - 面板打开时球心横向挪(globeFrame 的 shift):往返、以某点缩放照样对
 *   - 手绘符号:规划按球面距离留间距(高纬度不挤)、每帧挑选(背面不画、分级、从上到下排、快速档只画第一级)、
 *     山脊走向换算到屏幕上、大小和平面主图同样缩放时一样
 *   - 写实风重新打光:地球仪正中、北在上时和平面主图的明暗几乎一样;任何位置、任何视角,
 *     朝屏幕左上方的坡都是亮面、背着的都是暗面(两极不会光从背后来)
 * (画面在 scripts/globe-snap.ts 截图里看)
 */
import { describe, expect, it } from 'vitest';
import { GLOBE_PANEL_SHIFT, globeBasis, globeFrame, lonLatToScreen, reliefShade, screenToLonLat, zoomAt, type GlobeView, type Vec3 } from '../src/render/globe';
import { globeProjector } from '../src/render/globeLines';
import { globeGlyphScale, globeGlyphSet, placeGlobeGlyphs, sphereMetric, type GlobeGlyphView } from '../src/render/globeGlyphs';
import { G_MOUNTAIN, glyphScale, sphereStretch } from '../src/render/fantasy';
import { decodeSlope, realisticGlobePixels } from '../src/render/realistic';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { rasterize } from '../src/gen/raster';
import { REF_MAP_CSS } from '../src/render/labels/draw';
import { equivalentZoom } from '../src/render/globe';

const D = Math.PI / 180;
const W = 1400;
const H = 820;

describe('国家面板打开时球心左移', () => {
  it('球心挪 shift,半径不变;屏幕 ↔ 经纬度往返照样对', () => {
    const v: GlobeView = { lon: 0.4, lat: 0.3, k: 1.3 };
    const f0 = globeFrame(v, W, H);
    const f1 = globeFrame(v, W, H, GLOBE_PANEL_SHIFT);
    expect(f1.cx).toBe(f0.cx + GLOBE_PANEL_SHIFT);
    expect(f1.R).toBe(f0.R);
    // 视图中心在挪过的球心上
    const [x, y, d] = lonLatToScreen(v, f1, v.lon, v.lat);
    expect(x).toBeCloseTo(f1.cx, 9);
    expect(y).toBeCloseTo(f1.cy, 9);
    expect(d).toBeCloseTo(1, 9);
    for (const [sx, sy] of [
      [300, 200],
      [620, 500],
      [800, 390],
    ]) {
      const ll = screenToLonLat(v, f1, sx, sy)!;
      const back = lonLatToScreen(v, f1, ll[0], ll[1]);
      expect(back[0]).toBeCloseTo(sx, 6);
      expect(back[1]).toBeCloseTo(sy, 6);
    }
  });

  it('挪过的球上以某点缩放:那一点下面的地方缩放后还在那里', () => {
    const v: GlobeView = { lon: 1, lat: 0.2, k: 1 };
    const sx = 450;
    const sy = 330;
    const before = screenToLonLat(v, globeFrame(v, W, H, GLOBE_PANEL_SHIFT), sx, sy)!;
    const z = zoomAt(v, W, H, sx, sy, 2.5, GLOBE_PANEL_SHIFT);
    const after = screenToLonLat(z, globeFrame(z, W, H, GLOBE_PANEL_SHIFT), sx, sy)!;
    expect(Math.abs(after[0] - before[0])).toBeLessThan(1e-4);
    expect(Math.abs(after[1] - before[1])).toBeLessThan(1e-4);
  });
});

describe('手绘符号在地球仪上正立着画', () => {
  const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 20000 });
  const set = globeGlyphSet(world);
  const view = (lon: number, lat: number, k: number, quick = false): GlobeGlyphView => {
    const v = { lon: lon * D, lat: lat * D, k };
    const f = globeFrame(v, W, H);
    return { P: globeProjector(v, f), kEq: equivalentZoom(f.R, REF_MAP_CSS), unit: (2 * Math.PI * f.R) / world.width, quick };
  };

  it('林块的横向拉宽:赤道 1 倍、60° 两倍,两极附近封顶', () => {
    expect(sphereStretch(world.height / 2, world.height)).toBeCloseTo(1, 3);
    expect(sphereStretch(world.height / 6, world.height)).toBeCloseTo(2, 3);
    expect(sphereStretch(0, world.height)).toBe(24);
  });

  it('规划按球面上的距离留间距:高纬度全图就有的山不挤成一团', () => {
    const m = sphereMetric(world.height);
    const ms = set.glyphs.filter((g) => g.kind === G_MOUNTAIN && g.z <= 1 && Math.abs(world.height / 2 - g.y) > world.height / 4);
    let crowded = 0;
    for (let i = 0; i < ms.length; i++)
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i];
        const b = ms[j];
        let dx = b.x - a.x;
        dx -= world.width * Math.round(dx / world.width);
        const my = (a.y + b.y) / 2;
        if (Math.hypot(dx * m.fx(my), b.y - a.y) < 0.5 * Math.max(a.s, b.s)) crowded++;
      }
    expect(ms.length).toBeGreaterThan(20);
    expect(crowded).toBe(0);
  });

  it('背面不画;画出来的都在球的正面、按屏幕 y 从上到下排好;快速档只画第一级', () => {
    const v = view(30, 20, 3);
    const placed = placeGlobeGlyphs(set, v);
    expect(placed.length).toBeGreaterThan(20);
    for (let i = 0; i < placed.length; i++) {
      expect(placed[i].d).toBeGreaterThan(0);
      if (i) expect(placed[i].y).toBeGreaterThanOrEqual(placed[i - 1].y);
    }
    // 背面的地方(经度差 180°)一个都不在里面
    const back = placed.filter((p) => {
      const g = set.glyphs[p.i];
      const lon = (g.x / world.width) * 360 - 180;
      return Math.abs(((lon - 30 + 540) % 360) - 180) > 120;
    });
    expect(back.length).toBe(0);
    const quick = placeGlobeGlyphs(set, view(30, 20, 3, true));
    expect(quick.every((p) => set.glyphs[p.i].z <= 1)).toBe(true);
    expect(quick.length).toBeLessThan(placed.length);
  });

  it('大小和平面主图同样缩放时一样:glyphScale(等效缩放) × 一个世界单位的像素', () => {
    const v = view(0, 0, 2);
    expect(globeGlyphScale(v)).toBeCloseTo(glyphScale(v.kEq) * v.unit, 9);
    // 放大后出现更高一级的符号(按缩放分级)
    const z1 = placeGlobeGlyphs(set, view(0, 0, 1)).map((p) => set.glyphs[p.i].z);
    const z4 = placeGlobeGlyphs(set, view(0, 0, 4)).map((p) => set.glyphs[p.i].z);
    expect(Math.max(...z4)).toBeGreaterThan(Math.max(...z1));
  });

  it('山脊走向换到屏幕上:从正上方看极地的山,走向跟着视图转', () => {
    // 找一座高纬度、走向可信的山
    const i = set.glyphs.findIndex((g) => g.kind === G_MOUNTAIN && g.c > 0.5 && Math.abs(world.height / 2 - g.y) > world.height * 0.3);
    expect(i).toBeGreaterThanOrEqual(0);
    const g = set.glyphs[i];
    const lon = (g.x / world.width) * 360 - 180;
    const lat = 90 - (g.y / world.height) * 180;
    // 正对着这座山、北在上:走向 = 世界坐标里的走向按 cos 纬度压扁后的方向
    const at = (vlon: number, vlat: number) => placeGlobeGlyphs(set, view(vlon, vlat, 2)).find((p) => p.i === i);
    const p0 = at(lon, lat)!;
    const expected = Math.atan2(Math.sin(g.a), Math.cos(g.a) * Math.cos(lat * D));
    const fold = (a: number) => (a > Math.PI / 2 ? a - Math.PI : a <= -Math.PI / 2 ? a + Math.PI : a);
    expect(Math.abs(fold(p0.a - fold(expected)))).toBeLessThan(0.02);
    // 从极点正上方看(视图中心 = 极点):经度不同,屏幕上的走向不同
    const pole = lat > 0 ? 90 : -90;
    const a1 = at(lon, pole)?.a;
    const a2 = at(lon + 90, pole)?.a;
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(Math.abs(fold(a1! - a2!))).toBeGreaterThan(0.3);
  });
});

describe('写实风在地球仪上按屏幕方向重新打光', () => {
  const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 20000 });
  const r = rasterize(world, 1);
  const px = realisticGlobePixels(r);
  const slope = (k: number): [[number, number], [number, number]] => [
    [decodeSlope(px.slope[4 * k]), decodeSlope(px.slope[4 * k + 1])],
    [decodeSlope(px.slope[4 * k + 2]), decodeSlope(px.slope[4 * k + 3])],
  ];

  it('正对着看、北在上:和平面主图打好光的像素几乎一样(九成像素差不到 8 级)', () => {
    const errs: number[] = [];
    for (let k = 0; k < r.w * r.h; k += 97) {
      const x = k % r.w;
      const y = (k / r.w) | 0;
      const lat = Math.PI / 2 - ((y + 0.5) / r.h) * Math.PI;
      if (Math.abs(lat) > 60 * D) continue;
      const lon = ((x + 0.5) / r.w) * 2 * Math.PI - Math.PI;
      const b = globeBasis(lon, lat);
      const [gd, gm] = slope(k);
      const c: Vec3 = [px.albedo[4 * k], px.albedo[4 * k + 1], px.albedo[4 * k + 2]];
      const out = reliefShade(c, gd, gm, r.water[k] !== 0 && r.ice[k] < 0.5, b.c, lon, lat, b.e, b.n);
      let e = 0;
      for (let i = 0; i < 3; i++) e = Math.max(e, Math.abs(Math.min(255, Math.max(0, out[i])) - px.shaded[4 * k + i]));
      errs.push(e);
    }
    errs.sort((a, b) => a - b);
    expect(errs.length).toBeGreaterThan(1000);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(8);
  });

  it('任何位置(含两极)、任何视角:朝屏幕左上方升高的坡是暗面,反过来是亮面', () => {
    const gray: Vec3 = [128, 128, 128];
    let n = 0;
    for (let i = 0; i < 200; i++) {
      // 点:纬度覆盖到两极附近
      const lat = (-89 + ((i * 37) % 179)) * D;
      const lon = (((i * 71) % 360) - 180) * D;
      const p = globeBasis(lon, lat).c;
      // 视图:让这个点在正面(视图中心在它附近随便偏一点,极点正上方也算)
      const vlat = Math.max(-90, Math.min(90, lat / D + (((i * 13) % 50) - 25))) * D;
      const vlon = lon + (((i * 29) % 80) - 40) * D;
      const { c, e, n: up } = globeBasis(vlon, vlat);
      if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] < 0.3) continue;
      // 屏幕左上方投到这一点的切平面上:T = a·东 + b·北
      const Ls = [up[0] - e[0], up[1] - e[1], up[2] - e[2]];
      const lp = Ls[0] * p[0] + Ls[1] * p[1] + Ls[2] * p[2];
      const T = [Ls[0] - lp * p[0], Ls[1] - lp * p[1], Ls[2] - lp * p[2]];
      const E = [-Math.sin(lon), Math.cos(lon), 0];
      const N = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
      const a = T[0] * E[0] + T[1] * E[1] + T[2] * E[2];
      const b = T[0] * N[0] + T[1] * N[1] + T[2] * N[2];
      const l = Math.hypot(a, b);
      if (l < 1e-3) continue;
      // 坡度(东、南):朝 T 方向升高 = 东 a、南 −b
      const g: [number, number] = [(0.6 * a) / l, (-0.6 * b) / l];
      const away = reliefShade(gray, [0, 0], g, false, p, lon, lat, e, up)[0];
      const toward = reliefShade(gray, [0, 0], [-g[0], -g[1]], false, p, lon, lat, e, up)[0];
      expect(away).toBeLessThan(118);
      expect(toward).toBeGreaterThan(138);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });
});
