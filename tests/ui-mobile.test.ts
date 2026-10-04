/**
 * 手机布局的纯逻辑:双指捏合、手指双击、底部卡片(世界 / 详情)的几何、松手速度和松手停在哪、地图飞过去时"看得见的地方"、
 * 卡片开着时地图能往上推进卡片那一截、地名让开界面的矩形换算。
 */
import { describe, expect, it } from 'vitest';
import { ABOVE_SHEET, CAPSULE_GAP, CAPSULE_H, PEEK_H, VELOCITY_MS, isDoubleTap, peekHeight, pinchStep, releaseVelocity, sheetGeometry, sheetSnap, worldSnap } from '../src/ui/gestures';
import { NARROW_TOP_ROOM, freeArea, sideRoom } from '../src/ui/flyTo';
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

describe('底部卡片', () => {
  it('详情卡片半屏约占屏高一半、拉到顶在屏高 8%,一直铺到屏幕底;看得见的地图在顶上那截和卡片上的时间轴胶囊之间', () => {
    for (const H of [844, 740, 667]) {
      const g = sheetGeometry(H, NARROW_TOP_ROOM);
      expect(g.bottom).toBe(H);
      expect((g.bottom - g.halfTop) / H).toBeCloseTo(0.5, 2);
      expect(g.fullTop).toBeCloseTo(0.08 * H);
      expect(g.free).toEqual([NARROW_TOP_ROOM, g.halfTop - ABOVE_SHEET]);
    }
  });
  it('世界卡片收起时只露底下一截,时间轴胶囊在它上面', () => {
    const g = sheetGeometry(844, NARROW_TOP_ROOM);
    expect(g.peekTop).toBe(844 - PEEK_H);
    expect(ABOVE_SHEET).toBe(CAPSULE_H + 2 * CAPSULE_GAP);
  });
  it('刘海、底部横条:收起的世界卡片多出横条那一截(没横条时底下留 8);顶上那截和半屏的下限跟着刘海往下', () => {
    expect(peekHeight(0)).toBe(PEEK_H);
    expect(peekHeight(5)).toBe(PEEK_H);
    expect(peekHeight(34)).toBe(PEEK_H - 8 + 34);
    const g = sheetGeometry(844, NARROW_TOP_ROOM + 47, 34);
    expect(g.peekTop).toBe(844 - 134);
    expect(g.free[0]).toBe(NARROW_TOP_ROOM + 47);
    const short = sheetGeometry(420, NARROW_TOP_ROOM + 47, 34);
    expect(short.halfTop).toBeGreaterThanOrEqual(NARROW_TOP_ROOM + 47 + ABOVE_SHEET + 80);
  });
  it('很矮的屏幕:半屏的卡片至少露出 240 像素,上面至少留胶囊和一截地图', () => {
    for (const H of [420, 560]) {
      const g = sheetGeometry(H, NARROW_TOP_ROOM);
      expect(g.halfTop).toBeGreaterThanOrEqual(NARROW_TOP_ROOM + ABOVE_SHEET + 80);
      expect(g.fullTop).toBeLessThanOrEqual(g.halfTop);
      expect(g.free[1] - g.free[0]).toBeGreaterThanOrEqual(80);
    }
    expect(sheetGeometry(420, NARROW_TOP_ROOM).halfTop).toBe(420 - 240);
  });
  it('详情卡片松手:快甩往上 = 拉到顶;快甩往下 = 回半屏 / 关掉;慢慢拖停在最近的一档,拖到下面三分之一以下关掉', () => {
    const g = sheetGeometry(844, NARROW_TOP_ROOM);
    expect(sheetSnap('half', g.halfTop - 20, -1, g)).toBe('full');
    expect(sheetSnap('full', g.fullTop + 30, 1, g)).toBe('half');
    expect(sheetSnap('half', g.halfTop + 30, 1, g)).toBe('close');
    expect(sheetSnap('half', g.fullTop + 40, 0, g)).toBe('full');
    expect(sheetSnap('half', g.halfTop + 20, 0, g)).toBe('half');
    expect(sheetSnap('half', g.bottom - 60, 0, g)).toBe('close');
    expect(sheetSnap('full', g.halfTop - 30, 0.1, g)).toBe('half');
  });
  it('松手速度:只看最后一小段;甩完按住停一会儿再松手不算甩', () => {
    const flick = [
      { y: 700, t: 1000 },
      { y: 600, t: 1040 },
      { y: 500, t: 1080 },
    ];
    expect(releaseVelocity(flick, 480, 1090)).toBeCloseTo(-220 / 90);
    // 停了 300 毫秒才松手:速度 0,按位置停
    expect(releaseVelocity(flick, 500, 1080 + 300)).toBe(0);
    const g = sheetGeometry(844, NARROW_TOP_ROOM);
    expect(worldSnap(g.peekTop - 100, releaseVelocity(flick, 500, 1080 + 300), g)).toBe('peek');
    // 窗口边上的那一点还算;没有记录也不出 NaN
    expect(releaseVelocity([{ y: 0, t: 0 }], 60, VELOCITY_MS)).toBeCloseTo(60 / VELOCITY_MS);
    expect(releaseVelocity([], 10, 5)).toBe(0);
  });
  it('世界卡片松手:快甩往哪就去哪;慢慢拖停在离得近的那一档', () => {
    const g = sheetGeometry(844, NARROW_TOP_ROOM);
    expect(worldSnap(g.peekTop - 30, -0.8, g)).toBe('full');
    expect(worldSnap(g.fullTop + 30, 0.8, g)).toBe('peek');
    expect(worldSnap(g.fullTop + 100, 0, g)).toBe('full');
    expect(worldSnap(g.peekTop - 100, 0.2, g)).toBe('peek');
  });
});

describe('地图飞过去、卡片开着时的平移范围', () => {
  const desk: StageBox = { sw: 1440, sh: 900, bw: 1800, bh: 900 };
  const phone: StageBox = { sw: 390, sh: 844, bw: 1688, bh: 844 };
  it('宽屏:左边让出浮着的侧栏卡片(详情也在里面);上下留出右上的按钮和时间轴', () => {
    expect(sideRoom(1440)).toBe(400);
    expect(sideRoom(1024)).toBe(368);
    expect(sideRoom(390)).toBe(0);
    expect(freeArea(desk, true)).toEqual([400, 64, 1440, 796]);
    expect(freeArea(desk, false)).toEqual([400, 64, 1440, 796]);
  });
  it('窄屏:详情卡片开着时是卡片上的胶囊再往上、顶上那截往下;没开时让出收起的世界卡片和胶囊;左右不让', () => {
    const g = sheetGeometry(844, NARROW_TOP_ROOM);
    expect(freeArea(phone, true)).toEqual([0, NARROW_TOP_ROOM, 390, g.halfTop - ABOVE_SHEET]);
    expect(freeArea(phone, false)).toEqual([0, NARROW_TOP_ROOM, 390, 844 - PEEK_H - ABOVE_SHEET]);
  });
  it('padB:地图能往上推进卡片那一截(缩放 1 倍时本来不能上下动);没有 padB 时和原来一样', () => {
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
