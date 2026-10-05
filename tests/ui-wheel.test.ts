/**
 * 滚轮归类(src/ui/wheel.ts):鼠标滚轮缩放、触控板两指滑动平移、捏合跟着手指缩放
 */
import { describe, expect, it } from 'vitest';
import { GAP_MS, MAC_TICK, PINCH_RATE, WHEEL_RATE, createPinchGuard, createWheelReader, mouseLike, wheelTick, type WheelSample } from '../src/ui/wheel';

const ev = (p: Partial<WheelSample>): WheelSample => ({ deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, t: 0, ...p });

/** 一串滚动:每 16 毫秒一下 */
function run(read: ReturnType<typeof createWheelReader>, list: Partial<WheelSample>[], t0 = 0) {
  return list.map((p, i) => read(ev({ ...p, t: t0 + i * 16 })));
}

describe('鼠标滚轮', () => {
  it('Windows 一格 100 像素:缩放,倍数和以前一样', () => {
    const read = createWheelReader();
    expect(read(ev({ deltaY: -100 }))).toEqual({ kind: 'zoom', f: Math.exp(100 * WHEEL_RATE) });
    expect(read(ev({ deltaY: 100, t: 50 }))).toEqual({ kind: 'zoom', f: Math.exp(-100 * WHEEL_RATE) });
  });
  it('Mac 上慢慢转一格(4.000244140625 像素)和它的整数倍:缩放', () => {
    for (const n of [1, 2, 3, 7]) {
      const a = createWheelReader()(ev({ deltaY: -n * MAC_TICK }));
      expect(a?.kind).toBe('zoom');
    }
  });
  it('Windows 每格滚 1 行(33.33 像素):缩放', () => {
    expect(createWheelReader()(ev({ deltaY: 100 / 3 }))?.kind).toBe('zoom');
  });
  it('按行滚(Firefox 的鼠标):缩放,一行折成 40 像素', () => {
    expect(createWheelReader()(ev({ deltaMode: 1, deltaY: 3 }))).toEqual({ kind: 'zoom', f: Math.exp(-120 * WHEEL_RATE) });
  });
  it('Shift + 滚轮(横向):不动地图', () => {
    expect(createWheelReader()(ev({ deltaX: 100, shiftKey: true }))).toBeNull();
    // 有的浏览器按着 Shift 照样报在 deltaY 上
    expect(createWheelReader()(ev({ deltaY: 100, shiftKey: true }))).toBeNull();
    expect(createWheelReader()(ev({ deltaMode: 1, deltaY: 3, shiftKey: true }))).toBeNull();
  });
  it('一串滚轮中途按下 Shift:这几下不缩放,松开接着缩放', () => {
    const out = run(createWheelReader(), [{ deltaY: -100 }, { deltaY: -100, shiftKey: true }, { deltaY: -100 }]);
    expect(out.map((a) => a?.kind ?? null)).toEqual(['zoom', null, 'zoom']);
  });
  it('横向滚轮(按行滚、Windows 一格 100 像素、Mac 一格):不动地图,也不把这一串当成触控板', () => {
    for (const p of [{ deltaMode: 1, deltaX: 3 }, { deltaX: 100 }, { deltaX: -2 * MAC_TICK }]) {
      const read = createWheelReader();
      expect(read(ev(p))).toBeNull();
      expect(read(ev({ deltaY: -100, t: 16 }))?.kind).toBe('zoom');
    }
    const read = createWheelReader();
    run(read, [{ deltaY: -100 }, { deltaX: 100 }]);
    expect(read(ev({ deltaY: -MAC_TICK, t: 40 }))?.kind).toBe('zoom');
  });
  it('一串滚轮里中途的小数值也照样缩放(按开头定)', () => {
    const out = run(createWheelReader(), [{ deltaY: -MAC_TICK }, { deltaY: -3 }, { deltaY: -12 }]);
    expect(out.every((a) => a?.kind === 'zoom')).toBe(true);
  });
});

describe('触控板两指滑动', () => {
  it('上下滑:平移,不缩放(带松手后的惯性)', () => {
    const list = [1, 3, 6, 10, 14, 12, 9, 6, 4, 2, 1].map((d) => ({ deltaY: d }));
    const out = run(createWheelReader(), list);
    expect(out.every((a) => a?.kind === 'pan')).toBe(true);
    expect(out[3]).toEqual({ kind: 'pan', dx: 0, dy: 10 });
  });
  it('左右滑:平移', () => {
    expect(createWheelReader()(ev({ deltaX: -8 }))).toEqual({ kind: 'pan', dx: -8, dy: 0 });
  });
  it('开头一下就很大(甩得快),接着出现横向分量:改成平移', () => {
    const out = run(createWheelReader(), [{ deltaY: 60 }, { deltaX: 3, deltaY: 40 }, { deltaY: 20 }]);
    expect(out.map((a) => a?.kind)).toEqual(['zoom', 'pan', 'pan']);
  });
  it('停一会儿(超过 GAP_MS)再来一串:重新判断', () => {
    const read = createWheelReader();
    expect(read(ev({ deltaY: 5, t: 0 }))?.kind).toBe('pan');
    expect(read(ev({ deltaY: -100, t: 10 }))?.kind).toBe('pan');
    expect(read(ev({ deltaY: -100, t: 10 + GAP_MS + 1 }))?.kind).toBe('zoom');
  });
  it('数值是 0 的一下:什么都不做,也不定下是哪种', () => {
    const read = createWheelReader();
    expect(read(ev({}))).toBeNull();
    expect(read(ev({ deltaY: -100, t: 16 }))?.kind).toBe('zoom');
  });
});

describe('捏合和修饰键', () => {
  it('Chrome 的捏合(Ctrl + 小数值):倍数跟着手指', () => {
    // 两指张开到 2 倍,Chrome 分几下发,deltaY 合计 −100·ln 2
    const parts = [0.2, 0.3, 0.3, 0.2].map((w) => -100 * Math.log(2) * w);
    const out = run(
      createWheelReader(),
      parts.map((d) => ({ deltaY: d, ctrlKey: true })),
    );
    const f = out.reduce((m, a) => m * (a?.kind === 'zoom' ? a.f : 1), 1);
    expect(f).toBeCloseTo(2, 6);
  });
  it('捏合不受前面那串触控板滑动影响', () => {
    const read = createWheelReader();
    run(read, [{ deltaY: 5 }, { deltaY: 8 }]);
    expect(read(ev({ deltaY: -100 * Math.log(1.5), ctrlKey: true, t: 40 }))).toEqual({ kind: 'zoom', f: 1.5 });
  });
  it('Ctrl + 鼠标滚轮:按鼠标的比例缩放', () => {
    expect(createWheelReader()(ev({ deltaY: -100, ctrlKey: true }))).toEqual({ kind: 'zoom', f: Math.exp(100 * WHEEL_RATE) });
  });
  it('按住 ⌘ / Option 再两指滑:缩放(Magic Mouse 也能缩放)', () => {
    expect(createWheelReader()(ev({ deltaY: -10, metaKey: true }))).toEqual({ kind: 'zoom', f: Math.exp(10 * PINCH_RATE) });
    expect(createWheelReader()(ev({ deltaY: -10, altKey: true }))?.kind).toBe('zoom');
  });
  it('捏得快,一下的读数过了 50(不是整数):照样跟手', () => {
    expect(createWheelReader()(ev({ deltaY: -61.3, ctrlKey: true }))).toEqual({ kind: 'zoom', f: Math.exp(0.613) });
  });
  it('一下最多缩放 2 倍', () => {
    const a = createWheelReader()(ev({ deltaY: -45, ctrlKey: true }));
    expect(a).toEqual({ kind: 'zoom', f: Math.exp(0.45) });
    expect(createWheelReader()(ev({ deltaY: -100000 }))).toEqual({ kind: 'zoom', f: 2 });
  });
  it('按着修饰键的一串按开头定:捏得快时中途一下是 ≥ 50 的整数,照样按捏合的比例', () => {
    const out = run(createWheelReader(), [{ deltaY: -3.7 }, { deltaY: -60 }, { deltaY: -5 }].map((p) => ({ ...p, ctrlKey: true })));
    expect(out).toEqual([
      { kind: 'zoom', f: Math.exp(3.7 * PINCH_RATE) },
      { kind: 'zoom', f: Math.exp(60 * PINCH_RATE) },
      { kind: 'zoom', f: Math.exp(5 * PINCH_RATE) },
    ]);
  });
  it('按着修饰键的一串鼠标滚轮:中途的小数值也按鼠标的比例(不突然快 6 倍多)', () => {
    const out = run(createWheelReader(), [{ deltaY: -MAC_TICK }, { deltaY: -2.5 }].map((p) => ({ ...p, metaKey: true })));
    expect(out[1]).toEqual({ kind: 'zoom', f: Math.exp(2.5 * WHEEL_RATE) });
  });
  it('停一会儿再按着 Ctrl 滚:重新判断', () => {
    const read = createWheelReader();
    expect(read(ev({ deltaY: -100, ctrlKey: true, t: 0 }))).toEqual({ kind: 'zoom', f: Math.exp(100 * WHEEL_RATE) });
    expect(read(ev({ deltaY: -3, ctrlKey: true, t: GAP_MS + 1 }))).toEqual({ kind: 'zoom', f: Math.exp(3 * PINCH_RATE) });
  });
});

describe('createPinchGuard(别处的捏合不让网页放大)', () => {
  it('只认 Ctrl + 开头不像鼠标滚轮的一串', () => {
    const g = createPinchGuard();
    expect(g(ev({ deltaY: 3.2 }))).toBe(false);
    expect(g(ev({ deltaY: 3.2, ctrlKey: true, t: 1000 }))).toBe(true);
    expect(createPinchGuard()(ev({ deltaY: 100, ctrlKey: true }))).toBe(false);
    expect(createPinchGuard()(ev({ deltaY: MAC_TICK, ctrlKey: true }))).toBe(false);
    expect(createPinchGuard()(ev({ deltaMode: 1, deltaY: 1, ctrlKey: true }))).toBe(false);
  });
  it('捏合中途一下是 ≥ 50 的整数:整串照样拦下', () => {
    const g = createPinchGuard();
    const out = [-2.4, -60, -7.1].map((d, i) => g(ev({ deltaY: d, ctrlKey: true, t: i * 16 })));
    expect(out).toEqual([true, true, true]);
  });
  it('Ctrl + 鼠标滚轮的一串:中途的小数值也不拦(浏览器照常缩放网页)', () => {
    const g = createPinchGuard();
    const out = [100, 2.5].map((d, i) => g(ev({ deltaY: d, ctrlKey: true, t: i * 16 })));
    expect(out).toEqual([false, false]);
  });
});

describe('wheelTick / mouseLike', () => {
  it('≥ 50 的小数像素不算"一定是鼠标",但一串滚动的开头还是按鼠标', () => {
    expect(wheelTick(0, 61.3)).toBe(false);
    expect(mouseLike(0, 61.3)).toBe(true);
    expect(wheelTick(0, 100)).toBe(true);
  });
  it('触控板常见的小整数不算鼠标', () => {
    for (const d of [1, 2, 4, 8, 12, 16, 33, 49]) expect(mouseLike(0, d)).toBe(false);
  });
  it('≥ 50 像素、按行滚算鼠标', () => {
    expect(mouseLike(0, 50)).toBe(true);
    expect(mouseLike(0, -120)).toBe(true);
    expect(mouseLike(1, 1)).toBe(true);
  });
});
