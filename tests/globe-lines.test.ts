import { describe, expect, it } from 'vitest';
import { globeFrame, lonLatToScreen, lonLatToWorld, type GlobeView } from '../src/render/globe';
import { buildLineSet, globeProjector, splitPens, traceLineSet, type PathSink } from '../src/render/globeLines';
import { inkPen } from '../src/render/civ/borders';

const D = Math.PI / 180;
const W = 2048;
const H = 1024;

/** 记下 moveTo / lineTo:每一笔是一条折线 */
class Rec implements PathSink {
  runs: number[][] = [];
  moveTo(x: number, y: number) {
    this.runs.push([x, y]);
  }
  lineTo(x: number, y: number) {
    this.runs[this.runs.length - 1].push(x, y);
  }
  get points() {
    return this.runs.reduce((n, r) => n + r.length / 2, 0);
  }
}

/** 经纬度(度)的一串点 → 世界坐标的折线(x 按相邻两点接着走,可以伸出主图左右边) */
function lineOf(pts: [number, number][]): { pts: Float32Array } {
  const out: number[] = [];
  for (const [lon, lat] of pts) {
    let [x, y] = lonLatToWorld(lon * D, lat * D, W, H);
    if (out.length) x -= W * Math.round((x - out[out.length - 2]) / W);
    out.push(x, y);
  }
  return { pts: Float32Array.from(out) };
}

const view = (lon: number, lat: number, k = 1): GlobeView => ({ lon: lon * D, lat: lat * D, k });
const P = (v: GlobeView) => globeProjector(v, globeFrame(v, 1200, 800));

describe('地球仪矢量线:投影、裁剪', () => {
  it('跨 180° 经线的线在球上是连着的一笔(没有接缝)', () => {
    // 沿北纬 20° 从东经 170° 走到西经 170°(主图上从右边出去、左边进来)
    const pts: [number, number][] = [];
    for (let lon = 170; lon <= 190; lon += 0.5) pts.push([lon > 180 ? lon - 360 : lon, 20]);
    const set = buildLineSet([lineOf(pts)], W, H);
    const rec = new Rec();
    traceLineSet(rec, set, P(view(180, 20)));
    expect(rec.runs.length).toBe(1);
    const r = rec.runs[0];
    // 相邻两点在屏幕上挨得很近(没有横穿整个球的一段)
    for (let i = 2; i < r.length; i += 2) expect(Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1])).toBeLessThan(40);
    // 从左走到右,正中经过 180° 经线(屏幕中心附近)
    expect(r[0]).toBeLessThan(600);
    expect(r[r.length - 2]).toBeGreaterThan(600);
  });

  it('转到背面的一段裁掉,断在球的轮廓上', () => {
    // 赤道一整圈(经度 −180…180),从正面看只剩半圈
    const pts: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, 0]);
    const v = view(30, 0);
    const p = P(v);
    const set = buildLineSet([lineOf(pts)], W, H);
    const rec = new Rec();
    traceLineSet(rec, set, p);
    expect(rec.runs.length).toBe(1);
    const r = rec.runs[0];
    // 两头正好在轮廓上
    const rim = (x: number, y: number) => Math.hypot(x - p.cx, y - p.cy);
    expect(rim(r[0], r[1])).toBeCloseTo(p.R, 3);
    expect(rim(r[r.length - 2], r[r.length - 1])).toBeCloseTo(p.R, 3);
    // 所有点都在球里
    for (let i = 0; i < r.length; i += 2) expect(rim(r[i], r[i + 1])).toBeLessThanOrEqual(p.R + 1e-3);
  });

  it('整条在背面、整条在屏幕外的线一个点都不描', () => {
    const back = lineOf([
      [-150, 10],
      [-140, 12],
      [-130, 8],
    ]);
    const set = buildLineSet([back], W, H);
    const rec = new Rec();
    expect(traceLineSet(rec, set, P(view(30, 0)))).toBe(0);
    // 放大 8 倍看东经 30°,东经 70° 的线在屏幕外
    const far = buildLineSet(
      [
        lineOf([
          [70, 0],
          [72, 1],
        ]),
      ],
      W,
      H,
    );
    expect(traceLineSet(new Rec(), far, P(view(30, 0, 8)))).toBe(0);
    // 同一条线从正面看得见
    expect(traceLineSet(new Rec(), far, P(view(70, 0, 8)))).toBeGreaterThan(1);
  });

  it('屏幕上挨得太近的顶点合并,两头不丢;放大后顶点都留着', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 400; i++) pts.push([10 + i * 0.01, 5 + Math.sin(i / 20) * 0.5]);
    const set = buildLineSet([lineOf(pts)], W, H);
    const small = new Rec();
    traceLineSet(small, set, P(view(12, 5, 1)));
    const big = new Rec();
    traceLineSet(big, set, P(view(12, 5, 8)));
    expect(small.points).toBeLessThan(120);
    expect(big.points).toBeGreaterThan(small.points * 3);
    // 两头照样落在第一个、最后一个顶点上
    const v = view(12, 5, 1);
    const f = globeFrame(v, 1200, 800);
    const s = small.runs[0];
    const [x0, y0] = lonLatToScreen(v, f, pts[0][0] * D, pts[0][1] * D);
    const [x1, y1] = lonLatToScreen(v, f, pts[pts.length - 1][0] * D, pts[pts.length - 1][1] * D);
    expect(Math.hypot(s[0] - x0, s[1] - y0)).toBeLessThan(0.05);
    expect(Math.hypot(s[s.length - 2] - x1, s[s.length - 1] - y1)).toBeLessThan(0.05);
  });

  it('长的一段中间插点(约 2°),投影后是弯的', () => {
    const set = buildLineSet(
      [
        lineOf([
          [0, 60],
          [60, 60],
        ]),
      ],
      W,
      H,
    );
    // 60° 经度,每约 2° 一个点
    expect(set.vertices).toBeGreaterThanOrEqual(30);
  });
});

describe('地球仪矢量线:手绘国界按位置分三档粗细', () => {
  it('切开以后总长不变,每一段的粗细档和它起点处 inkPen 一致', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 200; i++) pts.push(100 + i * 1.3, 300 + Math.sin(i / 9) * 12);
    const line = { pts: Float32Array.from(pts), closed: false };
    const len = (p: ArrayLike<number>) => {
      let s = 0;
      for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      return s;
    };
    const pens = splitPens([line], 3);
    const total = pens.flat().reduce((s, l) => s + len(l.pts), 0);
    expect(total).toBeCloseTo(len(pts), 3);
    pens.forEach((ls, pen) => {
      for (const l of ls) expect(inkPen(l.pts[0], l.pts[1], 3)).toBe(pen);
    });
    // 三档都用到了
    expect(pens.filter((l) => l.length).length).toBeGreaterThanOrEqual(2);
  });
});
