/**
 * 手机布局的纯逻辑:双指捏合、手指双击、底部抽屉的几何和松手停在哪、地图飞过去时"看得见的地方"、
 * 抽屉开着时地图能往上推进抽屉那一截、地名让开界面的矩形换算。
 */
import { describe, expect, it } from 'vitest';
import { isDoubleTap, pinchStep, sheetGeometry, sheetSnap } from '../src/ui/gestures';
import { NARROW_ROW_H, NARROW_TOP_ROOM, PANEL_ROOM, freeArea } from '../src/ui/flyTo';
import { clampCurved, clampSphere, type StageBox } from '../src/ui/mapWrap';
import { reserveCanvasBoxes } from '../src/render/civ/labels';
import { sameBoxes } from '../src/ui/uiAvoid';

describe('双指捏合', () => {
  it('两指分开一倍 = 放大一倍,以两指中点为中心;两指一起移动 = 平移', () => {
    const s = pinchStep({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(s.f).toBeCloseTo(2);
    expect([s.mx, s.my, s.dx, s.dy]).toEqual([150, 100, 0, 0]);
    const t = pinchStep({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 80 }, { x: 230, y: 80 });
    expect(t.f).toBeCloseTo(1);
    expect([t.dx, t.dy]).toEqual([30, -20]);
  });
  it('两指贴在一起(距离不到 1 像素)时不缩放,不出 NaN', () => {
    const s = pinchStep({ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }, { x: 60, y: 10 });
    expect(s.f).toBe(1);
    expect(Number.isFinite(s.mx + s.my + s.dx + s.dy)).toBe(true);
  });
  it('手指点两下:够快、够近才算双击', () => {
    const a = { x: 100, y: 100, t: 1000 };
    expect(isDoubleTap(null, a)).toBe(false);
    expect(isDoubleTap(a, { x: 110, y: 105, t: 1200 })).toBe(true);
    expect(isDoubleTap(a, { x: 110, y: 105, t: 1500 })).toBe(false);
    expect(isDoubleTap(a, { x: 180, y: 100, t: 1200 })).toBe(false);
  });
});

describe('底部抽屉', () => {
  it('半高约占屏高 45%(在时间轴上面),展开到屏高 12%;看得见的地图在顶栏和抽屉之间', () => {
    for (const H of [844, 740, 667]) {
      const g = sheetGeometry(H, NARROW_ROW_H, NARROW_TOP_ROOM);
      expect(g.bottom).toBe(H - NARROW_ROW_H);
      expect((g.bottom - g.halfTop) / H).toBeCloseTo(0.45, 2);
      expect(g.fullTop).toBeCloseTo(0.12 * H);
      expect(g.free).toEqual([NARROW_TOP_ROOM, g.halfTop]);
    }
  });
  it('很矮的屏幕:半高的抽屉至少露出 200 像素,上面至少留一截地图', () => {
    const g = sheetGeometry(420, NARROW_ROW_H, NARROW_TOP_ROOM);
    expect(g.halfTop).toBeGreaterThanOrEqual(NARROW_TOP_ROOM + 80);
    expect(g.fullTop).toBeLessThanOrEqual(g.halfTop);
  });
  it('松手:快甩往上 = 展开;快甩往下 = 回半高 / 关掉;慢慢拖停在最近的一档,拖到下面三分之一以下关掉', () => {
    const g = sheetGeometry(844, NARROW_ROW_H, NARROW_TOP_ROOM);
    expect(sheetSnap('half', g.halfTop - 20, -1, g)).toBe('full');
    expect(sheetSnap('full', g.fullTop + 30, 1, g)).toBe('half');
    expect(sheetSnap('half', g.halfTop + 30, 1, g)).toBe('close');
    expect(sheetSnap('half', g.fullTop + 40, 0, g)).toBe('full');
    expect(sheetSnap('half', g.halfTop + 20, 0, g)).toBe('half');
    expect(sheetSnap('half', g.bottom - 60, 0, g)).toBe('close');
    expect(sheetSnap('full', g.halfTop - 30, 0.1, g)).toBe('half');
  });
});

describe('地图飞过去、抽屉开着时的平移范围', () => {
  const desk: StageBox = { sw: 1440, sh: 900, bw: 1800, bh: 900 };
  const phone: StageBox = { sw: 390, sh: 844, bw: 1688, bh: 844 };
  it('宽屏照旧:右边让出面板,上下留出世界名和时间轴', () => {
    expect(freeArea(desk, true)).toEqual([0, 84, 1440 - PANEL_ROOM, 800]);
    expect(freeArea(desk, false)).toEqual([0, 84, 1440, 800]);
  });
  it('窄屏:抽屉开着时是抽屉上方、顶栏下方那一截,左右不让', () => {
    const g = sheetGeometry(844, NARROW_ROW_H, NARROW_TOP_ROOM);
    expect(freeArea(phone, true)).toEqual([0, NARROW_TOP_ROOM, 390, g.halfTop]);
    expect(freeArea(phone, false)[3]).toBeGreaterThan(g.halfTop);
  });
  it('padB:地图能往上推进抽屉那一截(缩放 1 倍时本来不能上下动);没有 padB 时和原来一样', () => {
    const v = { k: 1, x: 0, y: -300 };
    expect(clampSphere(v, phone).y).toBe(0);
    expect(clampSphere(v, { ...phone, padB: 380 }).y).toBe(-300);
    expect(clampSphere({ k: 1, x: 0, y: -500 }, { ...phone, padB: 380 }).y).toBe(-380);
    expect(clampCurved(v, { ...phone, padB: 380 }).y).toBe(-300);
    expect(clampCurved(v, phone).y).toBe(0);
  });
});

describe('地名让开界面', () => {
  it('画布像素的矩形换成世界坐标,接在原有的 reserved 后面', () => {
    const view = { scale: 2, ox: -100, oy: 10, reserved: [[1, 2, 3, 4]] as [number, number, number, number][] };
    const r = reserveCanvasBoxes(view, [[0, 10, 100, 50]]);
    expect(r).toEqual([
      [1, 2, 3, 4],
      [50, 0, 100, 20],
    ]);
    // 原来的 view 不动
    expect(view.reserved.length).toBe(1);
  });
  it('界面没动(相差不到 2 像素)就不重排', () => {
    expect(sameBoxes([[0, 0, 10, 10]], [[1, 0, 10, 11]])).toBe(true);
    expect(sameBoxes([[0, 0, 10, 10]], [[5, 0, 10, 10]])).toBe(false);
    expect(sameBoxes([], [[0, 0, 1, 1]])).toBe(false);
  });
});
