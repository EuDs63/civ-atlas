import { describe, expect, it } from 'vitest';
import {
  GLOBE_K_MAX,
  GLOBE_K_MIN,
  dragView,
  globeBasis,
  globeFrame,
  graticuleLines,
  lerpView,
  lonLatToScreen,
  lonLatToWorld,
  renderGlobeCpu,
  screenToLonLat,
  screenToPixel,
  worldToLonLat,
  wrapAngle,
  zoomAt,
  type GlobeView,
} from '../src/render/globe';
import { GLOBE_HD_ZOOM, pickGlobeMark, wantHdTexture } from '../src/render/globe';

const D = Math.PI / 180;

/** 同一个方向的两个经纬度(经度按整圈比,极点附近经度不定) */
function sameDir(a: [number, number], b: [number, number], eps = 1e-9) {
  const va = [Math.cos(a[1]) * Math.cos(a[0]), Math.cos(a[1]) * Math.sin(a[0]), Math.sin(a[1])];
  const vb = [Math.cos(b[1]) * Math.cos(b[0]), Math.cos(b[1]) * Math.sin(b[0]), Math.sin(b[1])];
  return Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]) < eps;
}

describe('地球仪:正射投影', () => {
  it('视图的三个方向两两垂直、都是单位向量,北在上', () => {
    for (const [lon, lat] of [
      [0, 0],
      [2.1, 0.7],
      [-3, -1.2],
      [1, Math.PI / 2],
      [1, -Math.PI / 2],
    ]) {
      const { c, e, n } = globeBasis(lon, lat);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      for (const v of [c, e, n]) expect(dot(v, v)).toBeCloseTo(1, 12);
      expect(dot(c, e)).toBeCloseTo(0, 12);
      expect(dot(c, n)).toBeCloseTo(0, 12);
      expect(dot(e, n)).toBeCloseTo(0, 12);
      // 北(n)的 z 分量不为负:屏幕上方是北
      expect(n[2]).toBeGreaterThanOrEqual(-1e-12);
    }
  });

  it('屏幕点 → 经纬度 → 屏幕点 往返(各种视图、含两极正上方、跨 180° 经线)', () => {
    const views: GlobeView[] = [
      { lon: 0, lat: 0, k: 1 },
      { lon: 3.1, lat: 0.3, k: 2.5 },
      { lon: -2.4, lat: -0.9, k: 0.7 },
      { lon: 0.5, lat: Math.PI / 2, k: 1 },
      { lon: -1.5, lat: -Math.PI / 2, k: 4 },
    ];
    for (const v of views) {
      const f = globeFrame(v, 1400, 820);
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const sx = f.cx + (((i * 37) % 97) / 97 - 0.5) * 2 * f.R;
        const sy = f.cy + (((i * 53) % 89) / 89 - 0.5) * 2 * f.R;
        const ll = screenToLonLat(v, f, sx, sy);
        const inside = Math.hypot(sx - f.cx, sy - f.cy) <= f.R;
        expect(!!ll).toBe(inside);
        if (!ll) continue;
        n++;
        const [x, y, d] = lonLatToScreen(v, f, ll[0], ll[1]);
        expect(d).toBeGreaterThanOrEqual(-1e-9);
        expect(Math.hypot(x - sx, y - sy)).toBeLessThan(1e-6);
      }
      expect(n).toBeGreaterThan(100);
    }
  });

  it('经纬度 → 屏幕 → 经纬度 往返;背面的点朝向 < 0', () => {
    const v: GlobeView = { lon: 170 * D, lat: 25 * D, k: 1.6 };
    const f = globeFrame(v, 1000, 700);
    for (let lat = -85; lat <= 85; lat += 10) {
      for (let lon = -180; lon < 180; lon += 15) {
        const [x, y, d] = lonLatToScreen(v, f, lon * D, lat * D);
        if (d < 0.001) continue;
        const back = screenToLonLat(v, f, x, y)!;
        expect(sameDir(back, [lon * D, lat * D], 1e-7)).toBe(true);
      }
    }
    // 正对着的点在球心;对跖点在背面
    const c = lonLatToScreen(v, f, v.lon, v.lat);
    expect(c[0]).toBeCloseTo(f.cx, 9);
    expect(c[1]).toBeCloseTo(f.cy, 9);
    expect(c[2]).toBeCloseTo(1, 9);
    expect(lonLatToScreen(v, f, v.lon + Math.PI, -v.lat)[2]).toBeCloseTo(-1, 9);
    // 屏幕上方是北:中心往北一点,屏幕 y 变小
    expect(lonLatToScreen(v, f, v.lon, v.lat + 0.1)[1]).toBeLessThan(f.cy);
    // 屏幕右边是东
    expect(lonLatToScreen(v, f, v.lon + 0.1, v.lat)[0]).toBeGreaterThan(f.cx);
  });

  it('世界坐标 ↔ 经纬度:x = 0 是 180° 经线,正中是 0°;上北下南', () => {
    expect(worldToLonLat(1024, 512, 2048, 1024)[0]).toBeCloseTo(0, 12);
    expect(worldToLonLat(1024, 512, 2048, 1024)[1]).toBeCloseTo(0, 12);
    expect(Math.abs(worldToLonLat(0, 0, 2048, 1024)[0])).toBeCloseTo(Math.PI, 12);
    expect(worldToLonLat(0, 0, 2048, 1024)[1]).toBeCloseTo(Math.PI / 2, 12);
    // x 超出 [0, W) 按整圈
    expect(sameDir(worldToLonLat(2048 + 300, 200, 2048, 1024), worldToLonLat(300, 200, 2048, 1024))).toBe(true);
    for (const [x, y] of [
      [0.5, 3],
      [2047.2, 1000],
      [1500, 512],
    ]) {
      const [lon, lat] = worldToLonLat(x, y, 2048, 1024);
      const [x2, y2] = lonLatToWorld(lon, lat, 2048, 1024);
      expect(x2).toBeCloseTo(x, 8);
      expect(y2).toBeCloseTo(y, 8);
    }
  });

  it('点选命中:屏幕上一座城的位置反投影回主图,落在它所在的那个像素', () => {
    const W = 2048;
    const H = 1024;
    const v: GlobeView = { lon: -175 * D, lat: -40 * D, k: 3 };
    const f = globeFrame(v, 1400, 820);
    // 城在主图上的位置(跨 180° 经线附近、南半球)
    for (const [wx, wy] of [
      [12.3, 760.8],
      [2040.6, 700.2],
      [30.5, 820.5],
    ]) {
      const [lon, lat] = worldToLonLat(wx, wy, W, H);
      const [sx, sy, d] = lonLatToScreen(v, f, lon, lat);
      expect(d).toBeGreaterThan(0);
      const px = screenToPixel(v, f, sx, sy, W, H)!;
      expect(px).toEqual([Math.floor(wx), Math.floor(wy)]);
    }
    // 球外 = null
    expect(screenToPixel(v, globeFrame({ ...v, k: 1 }, 1400, 820), 2, 2, W, H)).toBeNull();
  });

  it('点选符号:取离点击处最近、在容差以内、朝着观察者的那一个', () => {
    const marks = [
      { x: 100, y: 100, d: 0.9 },
      { x: 108, y: 100, d: 0.9 },
      { x: 300, y: 300, d: -0.2 },
    ];
    expect(pickGlobeMark(marks, 106, 101, 10)).toBe(1);
    expect(pickGlobeMark(marks, 101, 99, 10)).toBe(0);
    expect(pickGlobeMark(marks, 300, 300, 10)).toBe(-1);
    expect(pickGlobeMark(marks, 150, 150, 10)).toBe(-1);
  });

  it('拖动:横拖转经度(跨 ±180° 取模)、竖拖俯仰,夹在两极以内', () => {
    const v: GlobeView = { lon: 179 * D, lat: 0, k: 1 };
    const a = dragView(v, 300, -300 * 3 * D, 0);
    expect(a.lon).toBeCloseTo(wrapAngle(182 * D), 9);
    expect(a.lon).toBeLessThan(0);
    const b = dragView(v, 300, 0, 10000);
    expect(b.lat).toBeCloseTo(Math.PI / 2, 12);
    const c = dragView(v, 300, 0, -10000);
    expect(c.lat).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('滚轮缩放:鼠标下的地方缩放后还在鼠标下;倍数夹在上下限内', () => {
    const v: GlobeView = { lon: 0.4, lat: 0.3, k: 1 };
    const w = 1400;
    const h = 820;
    const sx = 900;
    const sy = 300;
    const before = screenToLonLat(v, globeFrame(v, w, h), sx, sy)!;
    const z = zoomAt(v, w, h, sx, sy, 3);
    expect(z.k).toBe(3);
    const after = screenToLonLat(z, globeFrame(z, w, h), sx, sy)!;
    expect(sameDir(before, after, 1e-5)).toBe(true);
    expect(zoomAt(v, w, h, sx, sy, 100).k).toBe(GLOBE_K_MAX);
    expect(zoomAt(v, w, h, sx, sy, 0.01).k).toBe(GLOBE_K_MIN);
  });

  it('飞过去走短边:从 170°E 到 170°W 只转 20°', () => {
    const a: GlobeView = { lon: 170 * D, lat: 0, k: 1 };
    const b: GlobeView = { lon: -170 * D, lat: 0, k: 1 };
    const m = lerpView(a, b, 0.5);
    expect(Math.abs(wrapAngle(m.lon - Math.PI))).toBeLessThan(1e-9);
  });

  it('经纬网只画朝着观察者的一半', () => {
    const v: GlobeView = { lon: 0.3, lat: 0.5, k: 1 };
    const f = globeFrame(v, 800, 800);
    const lines = graticuleLines(v, f, 30 * D);
    expect(lines.length).toBeGreaterThan(8);
    for (const l of lines) for (let i = 0; i < l.length; i += 2) expect(Math.hypot(l[i] - f.cx, l[i + 1] - f.cy)).toBeLessThanOrEqual(f.R + 1e-6);
  });

  it('高清贴图:缩放 1 倍时不铺(两倍像素密度的屏幕上也不铺);放大到 1.5 倍以上、贴图确实不够清楚才铺;有了 / 正在铺 / 失败过 / 回放时不铺', () => {
    const base = { have: false, pending: false, failed: false, replaying: false, maxTexture: 8192, hdWidth: 4096 };
    // 缩放 1 倍:哪怕屏幕像素密度 2 倍、一个贴图像素占 2.2 个屏幕像素
    expect(wantHdTexture({ ...base, k: 1, texel: 2.2 })).toBe(false);
    expect(wantHdTexture({ ...base, k: GLOBE_HD_ZOOM - 0.01, texel: 3 })).toBe(false);
    expect(wantHdTexture({ ...base, k: GLOBE_HD_ZOOM, texel: 1.5 })).toBe(true);
    expect(wantHdTexture({ ...base, k: 4, texel: 6 })).toBe(true);
    // 小屏幕:放大了,但主图那张还没被放大显示
    expect(wantHdTexture({ ...base, k: 2, texel: 0.9 })).toBe(false);
    expect(wantHdTexture({ ...base, k: 4, texel: 6, have: true })).toBe(false);
    expect(wantHdTexture({ ...base, k: 4, texel: 6, pending: true })).toBe(false);
    expect(wantHdTexture({ ...base, k: 4, texel: 6, failed: true })).toBe(false);
    expect(wantHdTexture({ ...base, k: 4, texel: 6, replaying: true })).toBe(false);
    expect(wantHdTexture({ ...base, k: 4, texel: 6, maxTexture: 4000 })).toBe(false);
  });

  it('CPU 画法:球里取到贴图的颜色,球外是背景,不出 NaN', () => {
    const tw = 64;
    const th = 32;
    const tex = new Uint8ClampedArray(tw * th * 4);
    for (let i = 0; i < tw * th; i++) {
      // 左半边(西半球)红、右半边(东半球)绿
      const x = i % tw;
      tex[i * 4] = x < tw / 2 ? 220 : 10;
      tex[i * 4 + 1] = x < tw / 2 ? 10 : 220;
      tex[i * 4 + 3] = 255;
    }
    const out = { w: 120, h: 100, data: new Uint8ClampedArray(120 * 100 * 4) };
    const v: GlobeView = { lon: 0, lat: 0, k: 1 };
    const f = globeFrame(v, out.w, out.h);
    renderGlobeCpu(out, v, f, { style: 'data', graticule: false, hl: 0, replay: 0 }, { terrain: { w: tw, h: th, data: tex } });
    const at = (x: number, y: number) => Array.from(out.data.slice((y * out.w + x) * 4, (y * out.w + x) * 4 + 4));
    const west = at(Math.round(f.cx - f.R * 0.5), Math.round(f.cy));
    const east = at(Math.round(f.cx + f.R * 0.5), Math.round(f.cy));
    expect(west[0]).toBeGreaterThan(west[1]);
    expect(east[1]).toBeGreaterThan(east[0]);
    expect(at(0, 0)).toEqual([13, 15, 18, 255]);
    for (const v of out.data) expect(Number.isFinite(v)).toBe(true);
  });
});
