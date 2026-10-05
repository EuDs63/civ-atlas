/**
 * 滚轮事件归成"缩放"还是"平移"(纯计算,不碰 DOM,单测直接测)。和 Mac 自带的「地图」一样:
 *
 *   触控板两指滑动        → 平移(松手后系统接着发的惯性滚动也跟着滑)
 *   触控板两指捏合        → 缩放,跟着手指走(浏览器把捏合报成按着 Ctrl 的滚轮,deltaY = −100·ln(两指张开的倍数))
 *   鼠标滚轮              → 缩放(和以前一样;横向滚轮 / Shift + 滚轮不动地图)
 *   按住 ⌘ / Ctrl / Option 再滑 → 缩放(Magic Mouse、被当成触控板的顺滑滚轮也能缩放)
 *
 * 浏览器不说是触控板还是鼠标,只能看数值猜。一串连着的滚动(相邻两下不超过 GAP_MS)按开头定下来,中途不改
 * (惯性滚动的数值越来越小,捏得快时一下又可能很大,不能让它半路变成别的;按着修饰键的一串也一样):
 *   - 按行 / 按页滚(deltaMode ≠ 0,Firefox 的鼠标)、一下 ≥ 50 像素、正好是 Mac 鼠标一格(4.000244140625 像素)
 *     或 Windows 一行(100 / 3 像素)的整数倍 → 鼠标
 *   - 只有横向、数值也是这样的一下(横向滚轮)→ 鼠标(不动地图)
 *   - 带横向分量(没按 Shift)或者别的小数值 → 触控板
 * 猜错的代价:顺滑滚动的鼠标(装了平滑滚动软件的)会被当成触控板,滚轮变成上下平移;按住 ⌘ 再滚就是缩放。
 *
 * 读 deltaMode 要在读 deltaX / deltaY 之前:Firefox 看谁先被读,先读 deltaMode 才报真实的"按行",否则全换算成像素
 * (换算成的像素和触控板分不开)。
 */

export interface WheelSample {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** 事件时间(毫秒,单调递增就行) */
  t: number;
}

export type WheelAction = { kind: 'zoom'; f: number } | { kind: 'pan'; dx: number; dy: number };

/** 一串滚动里相邻两下隔多久算断开(毫秒) */
export const GAP_MS = 300;
/** 鼠标滚轮:每像素缩放多少(和以前一样,Windows 上一格 100 像素 ≈ 1.16 倍) */
export const WHEEL_RATE = 0.0015;
/** 捏合:deltaY = −100·ln(倍数),按 1 / 100 换回去就正好跟手 */
export const PINCH_RATE = 0.01;
/** 一下最多缩放多少倍(防一下子跳太远) */
const MAX_STEP = 2;
/** 一行 / 一页折成多少像素(按行滚的鼠标) */
const LINE_PX = 40;
const PAGE_PX = 800;
/** Mac 上 Chrome、Safari 的鼠标滚轮慢慢转一格的像素数(转得快是它的整数倍) */
export const MAC_TICK = 4.000244140625;
/** Windows 上 Chrome 的滚轮一行(系统设置每格滚 1 行、2 行时一格就是它的 1、2 倍) */
const WIN_LINE = 100 / 3;
/** 一下这么多像素只会是鼠标滚轮(触控板一串滚动的头几下都很小) */
const MOUSE_MIN = 50;

const multipleOf = (a: number, unit: number) => {
  const n = Math.round(a / unit);
  return n >= 1 && Math.abs(a - n * unit) < 1e-4;
};

/**
 * 这一下一定是鼠标滚轮转了几格:按行 / 按页滚,正好是 Mac 一格、Windows 一行的整数倍,或者 ≥ 50 的整数像素
 * (捏合的读数是 100·ln 倍数,几乎不会是整数;捏得快时一下也能到四五十)
 */
export function wheelTick(mode: number, dy: number): boolean {
  if (mode !== 0) return true;
  const a = Math.abs(dy);
  return multipleOf(a, MAC_TICK) || multipleOf(a, WIN_LINE) || (a >= MOUSE_MIN && Number.isInteger(a));
}

/** 一串滚动开头这一下像不像鼠标滚轮(dy 已经折成像素):除了上面那些,≥ 50 像素的也算 */
export function mouseLike(mode: number, dy: number): boolean {
  return wheelTick(mode, dy) || Math.abs(dy) >= MOUSE_MIN;
}

const clampStep = (f: number) => (Number.isFinite(f) ? Math.min(MAX_STEP, Math.max(1 / MAX_STEP, f)) : 1);

/** 一串连着的滚动按开头定下来的种类:get 在隔了 GAP_MS 以上时先清掉(null = 还没定) */
function streamLatch<K>() {
  let kind: K | null = null;
  let last = -Infinity;
  return {
    get(t: number): K | null {
      if (t - last > GAP_MS) kind = null;
      last = t;
      return kind;
    },
    set(k: K) {
      kind = k;
    },
  };
}

/**
 * 一个读滚轮的"读头"(地图、地球仪各用一个):每来一下滚轮交给它,返回这一下该缩放还是平移。
 * dx / dy 是内容该往反方向挪的像素(和网页滚动同向:两指往上推 = dy > 0 = 地图往上走);null = 什么都不做
 */
export function createWheelReader() {
  const plain = streamLatch<'mouse' | 'trackpad'>();
  /** 按着修饰键的一串:鼠标滚轮(按老的比例)还是捏合 / 触控板(按跟手的比例) */
  const mod = streamLatch<'wheel' | 'pinch'>();
  return (e: WheelSample): WheelAction | null => {
    const mode = e.deltaMode;
    const unit = mode === 1 ? LINE_PX : mode === 2 ? PAGE_PX : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    // 捏合、按着修饰键:缩放
    if (e.ctrlKey || e.metaKey || e.altKey) {
      let k = mod.get(e.t);
      if (!dy) return null;
      if (!k) mod.set((k = wheelTick(mode, dy) ? 'wheel' : 'pinch'));
      return { kind: 'zoom', f: clampStep(Math.exp(-dy * (k === 'wheel' ? WHEEL_RATE : PINCH_RATE))) };
    }
    let kind = plain.get(e.t);
    if (kind === null) {
      if (mode !== 0 || (!dy && wheelTick(mode, dx))) kind = 'mouse';
      else if (dx && !e.shiftKey) kind = 'trackpad';
      else if (dy) kind = mouseLike(mode, dy) ? 'mouse' : 'trackpad';
      else return null;
      plain.set(kind);
    } else if (kind === 'mouse' && dx && !e.shiftKey && mode === 0 && !wheelTick(mode, dx)) {
      // 开头一下很大、看着像鼠标,接着出现了横向分量:其实是触控板甩得快
      plain.set((kind = 'trackpad'));
    }
    if (kind === 'trackpad') return dx || dy ? { kind: 'pan', dx, dy } : null;
    // Shift + 鼠标滚轮是横着滚:有的浏览器照样报在 deltaY 上,也不缩放
    if (e.shiftKey) return null;
    return dy ? { kind: 'zoom', f: clampStep(Math.exp(-dy * WHEEL_RATE)) } : null;
  };
}

/**
 * 网页别的地方(侧栏、时间轴、按钮)收到的 Ctrl 滚轮是不是捏合:是就拦下,不让浏览器放大整个页面。
 * 和上面一样按一串的开头定:开头不像鼠标滚轮的一串整串都算捏合
 */
export function createPinchGuard() {
  const pinch = streamLatch<boolean>();
  return (e: Pick<WheelSample, 'deltaMode' | 'deltaY' | 'ctrlKey' | 't'>): boolean => {
    if (!e.ctrlKey) return false;
    const mode = e.deltaMode;
    let k = pinch.get(e.t);
    if (k === null) {
      if (!e.deltaY) return false;
      pinch.set((k = !wheelTick(mode, e.deltaY)));
    }
    return k;
  };
}

/**
 * Safari 的触控板捏合不发 Ctrl 滚轮,发 gesturestart / gesturechange(App 接住转成缩放)。
 * 万一同时也发了 Ctrl 滚轮,捏合进行中的 Ctrl 滚轮不再算一遍
 */
let gesturePinch = false;
export const setGesturePinch = (on: boolean) => {
  gesturePinch = on;
};
export const inGesturePinch = () => gesturePinch;

/** WheelEvent → WheelSample(先读 deltaMode,见文件开头) */
export function wheelSample(e: WheelEvent): WheelSample {
  const deltaMode = e.deltaMode;
  return { deltaMode, deltaX: e.deltaX, deltaY: e.deltaY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, t: e.timeStamp };
}
