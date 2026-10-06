/**
 * 新建界面的星球(纯计算的部分):网格和各种投影下的位置、板块漂移的转轴表和板块贴图、开场正对着的经线、
 * 星球在两边面板之间怎么摆、摊平改地形时平面地图的位置、建好以后平常页面的地图在哪;
 * 助手列出的改地形在星球上圈出来时的中心;地球仪的地名按给定的球心、半径摆
 */
import { describe, expect, it } from 'vitest';
import {
  DRIFT_MAX,
  PLATE_MAX,
  driftLoop,
  landCenterLon,
  planetLayout,
  planetMesh,
  plateRotations,
  plateTexels,
  wrapPi,
} from '../src/render/planet';
import { PROJECTION_IDS, PROJECTIONS } from '../src/render/projection';
import { appPose, driftYears, easeInOut, fitPose, flatRect, lerpPose, projExtent } from '../src/ui/studio/layout';
import { marksCenter } from '../src/ui/studio/planetMarks';
import { globeLabelView, globeToCanvas } from '../src/render/globeLabels';
import type { World } from '../src/gen/world';

describe('星球网格和投影', () => {
  it('网格:顶点数、经纬度范围,三角形下标都在顶点数以内', () => {
    const m = planetMesh(8, 4);
    expect(m.vertexCount).toBe(9 * 5);
    expect(m.index.length).toBe(8 * 4 * 6);
    expect(Math.max(...m.index)).toBe(m.vertexCount - 1);
    expect(m.ll[0]).toBeCloseTo(-Math.PI);
    expect(m.ll[1]).toBeCloseTo(Math.PI / 2);
    expect(m.ll[m.ll.length - 2]).toBeCloseTo(Math.PI);
    expect(m.ll[m.ll.length - 1]).toBeCloseTo(-Math.PI / 2);
    // 默认大小的网格用 16 位下标放得下
    expect(planetMesh().vertexCount).toBeLessThan(65536);
  });

  it('各种投影的宽高和 projExtent 对得上;地球仪 = 直径 2', () => {
    const m = planetMesh();
    const g = planetLayout(m, 'globe');
    expect([g.w, g.h]).toEqual([2, 2]);
    expect(projExtent('globe')).toEqual({ w: 2, h: 2 });
    for (const id of PROJECTION_IDS) {
      const l = planetLayout(m, id);
      const e = projExtent(id);
      expect(l.w).toBeCloseTo(e.w, 3);
      expect(l.h).toBeCloseTo(e.h, 3);
      for (const v of l.pos) expect(Number.isFinite(v)).toBe(true);
    }
    // 等距圆柱正好 2:1
    const eq = projExtent('equirect');
    expect(eq.w / eq.h).toBeCloseTo(2, 5);
    // 墨卡托两极截在 latMax:最上一行顶点的 y 就是 latMax 那里的 y
    const mc = planetLayout(m, 'mercator');
    expect(mc.pos[1]).toBeCloseTo(PROJECTIONS.mercator.y(PROJECTIONS.mercator.latMax), 5);
  });
});

describe('板块漂移', () => {
  it('转轴表:转得最快的转 DRIFT_MAX、其余按比例,转轴是单位向量;没有角速度的不转', () => {
    const omega = [0, 0, 2, 1, 0, 0, 0, 0, 0];
    const r = plateRotations(omega, 3);
    expect(r.length).toBe(PLATE_MAX * 4);
    expect([...r.slice(0, 4)]).toEqual([0, 0, 1, expect.closeTo(DRIFT_MAX, 6)]);
    expect([...r.slice(4, 8)]).toEqual([1, 0, 0, expect.closeTo(DRIFT_MAX / 2, 6)]);
    expect(r[11]).toBe(0);
    expect([...plateRotations([0, 0, 0], 1)].every((v) => v === 0)).toBe(true);
  });

  it('板块贴图:R = 板块号,G = 陆地,B = 大陆板块;按目标大小隔行隔列取样', () => {
    // 2 × 1 的栅格:左边地块 0(板块 3、陆地、大陆板块),右边地块 1(板块 5、海、洋壳)
    const px = plateTexels(new Int32Array([0, 1]), 2, 1, [3, 5], [0, 1], [0, 0, 0, 1, 0, 0], 4, 2);
    expect([...px.slice(0, 4)]).toEqual([3, 255, 255, 255]);
    expect([...px.slice(12, 16)]).toEqual([5, 0, 0, 255]);
    expect([...px.slice(16, 20)]).toEqual([3, 255, 255, 255]);
  });

  it('漂移着色器循环的块数:往上取 16 的倍数;统一变量不够就不放漂移', () => {
    expect(driftLoop(30, 1024)).toBe(32);
    expect(driftLoop(5, 1024)).toBe(16);
    expect(driftLoop(60, 1024)).toBe(64);
    expect(driftLoop(30, 40)).toBe(32);
    expect(driftLoop(60, 64)).toBe(0);
  });

  it('开场正对着陆地最集中的经线', () => {
    const w = 360;
    const h = 180;
    const px = new Uint8Array(w * h * 4);
    // 东经 90° 一带(x = 270)有一块陆地
    for (let y = 60; y < 120; y++) for (let x = 250; x < 290; x++) px[(y * w + x) * 4 + 1] = 255;
    const lon = (landCenterLon(px, w, h) * 180) / Math.PI;
    expect(Math.abs(lon - 90)).toBeLessThan(3);
  });

  it('经度差取到 (−π, π]', () => {
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapPi(Math.PI / 2 + 4 * Math.PI)).toBeCloseTo(Math.PI / 2);
    expect(wrapPi(-Math.PI / 3)).toBeCloseTo(-Math.PI / 3);
  });
});

describe('星球怎么摆', () => {
  const box = { x: 340, y: 0, w: 1032, h: 900 };
  it('地球仪:半径 = 短边 × 0.38(手机 0.42),在这块地方正中', () => {
    const p = fitPose('globe', box, { phone: false, intro: false });
    expect(p.k).toBeCloseTo(900 * 0.38);
    expect(p.cx).toBe(340 + 516);
    expect(fitPose('globe', { x: 0, y: 0, w: 390, h: 500 }, { phone: true, intro: false }).k).toBeCloseTo(390 * 0.42);
  });

  it('平面地图放得下(四周留边),摊平时的平面地图正好 2:1、整像素', () => {
    for (const id of PROJECTION_IDS) {
      const p = fitPose(id, box, { phone: false, intro: false });
      const e = projExtent(id);
      expect(e.w * p.k).toBeLessThanOrEqual(box.w - 2 * 44 + 1e-6);
      expect(e.h * p.k).toBeLessThanOrEqual(box.h - 44 - 90 + 1e-6);
    }
    const r = flatRect(box, { phone: false, intro: false });
    expect(r.w).toBe(r.h * 2);
    expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
    expect(Math.abs(r.x + r.w / 2 - (box.x + box.w / 2))).toBeLessThanOrEqual(1);
  });

  it('建好以后:等距圆柱铺满按舞台"盖满"的地图框;弯边投影比它小一点', () => {
    const eq = appPose('equirect', 1600, 900);
    expect(eq.k * 2 * Math.PI).toBeCloseTo(1800);
    expect([eq.cx, eq.cy]).toEqual([800, 450]);
    const rb = appPose('robinson', 1600, 900);
    expect(rb.k * projExtent('robinson').w).toBeLessThan(1800);
  });

  it('补间:两头对上;缓动两头平、中间过 0.5;漂移字幕的年代', () => {
    const a = { k: 1, cx: 0, cy: 0 };
    const b = { k: 3, cx: 10, cy: -10 };
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toEqual(b);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1);
    expect(driftYears(0)).toBe('约 1.8 亿年前');
    expect(driftYears(0.5)).toBe('约 9000 万年前');
    expect(driftYears(1)).toBe('今天');
  });
});

describe('星球上圈出要改的地方', () => {
  const world = { width: 2048, height: 1024 } as World;
  const op = (pts: number[]) => ({ n: 1, op: { kind: 'lake' as const, pts, r: 30, s: 1 } });

  it('一处:中心就是它的经纬度', () => {
    const c = marksCenter([op([1536, 256])], world)!;
    expect((c[0] * 180) / Math.PI).toBeCloseTo(90);
    expect((c[1] * 180) / Math.PI).toBeCloseTo(45);
  });

  it('跨 180° 经线的两处:中心在 180° 经线上(按球面平均,不是平面上的平均)', () => {
    const c = marksCenter([op([10, 512]), op([2038, 512])], world)!;
    expect(Math.abs(Math.abs(c[0]) - Math.PI)).toBeLessThan(0.01);
    expect(c[1]).toBeCloseTo(0);
  });

  it('没有点 = 没有中心', () => {
    expect(marksCenter([], world)).toBeNull();
  });

  it('地球仪的地名按给定的球心、半径摆(新建界面的星球):正对着的一点在球心', () => {
    const lv = globeLabelView({ view: { lon: 0, lat: 0, k: 1 }, w: 1600, h: 900, dpr: 2, worldW: 2048, worldH: 1024, frame: { cx: 700, cy: 400, R: 300 } });
    // 经度 0 = 世界 x 的一半,纬度 0 = 世界 y 的一半
    const [x, y, d] = globeToCanvas(lv, 1024, 512);
    expect(x).toBeCloseTo(1400);
    expect(y).toBeCloseTo(800);
    expect(d).toBeCloseTo(1);
    expect(lv.globe.R).toBeCloseTo(600);
  });
});
