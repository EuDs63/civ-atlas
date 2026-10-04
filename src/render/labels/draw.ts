/**
 * 地图文字层:把一批标注(LabelItem)画到一张和视口一样大的画布上。
 *
 * 对外是 drawLabels(ctx, items, view)(只有文字)和 placeMap(items, marks, view)(文字 + 符号一起避让)。
 * 地理名(海、山、河、湖、岛、荒漠)、国名、城名和城镇符号的排版、避让、光晕、按缩放显示都在这里统一处理:
 *
 *   1. 按缩放过滤:k < minZoom 的不画;刚到门槛时淡入
 *   2. 文字和符号(LabelMark,如城镇图标)按 priority 从高到低排队放:
 *      - 符号只有一个位置,和已放的东西重叠就不画(forced 的总画,如国都);
 *      - 文字有若干候选摆法(layout.ts,或 item.place 自己给),挑第一个
 *        ① 不出地图边框 ② 不和已放的字、符号重叠(自己那个符号除外)③ 字下面的地面符合要求(海名在水上、山名在陆上,
 *        不压着海岸线;国名在本国国土里)的;都不行就不画 —— 所以文字之间永远不重叠
 *   3. 画:先描光晕(strokeText),再填字
 *
 * 所有排版在画布像素里做;字号用 CSS 像素给,按 devicePixelRatio 放大,放大地图后文字依然清晰。
 */
import { glyphBox, layoutCurve, layoutLine, layoutPoint, layoutRiver, Polyline, SURFACE, type Candidate, type Glyph } from './layout';
import { fontCss } from './fonts';

export { SURFACE };

export type LabelLayout = 'line' | 'curve' | 'river' | 'point';

export interface LabelItem {
  text: string;
  /**
   * 锚点路径(世界单位 x,y,x,y…)。layout 决定怎么用它:
   *   line  过中心的一段直线,文字在线上均匀散开(海、荒漠、岛;国名)
   *   curve 沿折线排,字随路径转;路径很陡时竖排(山脉)
   *   river 沿折线,每个字正立,排在线的一侧(河)
   *   point 一个点,先试放在正中,放不下放旁边(湖;城镇)
   */
  path: ArrayLike<number>;
  layout: LabelLayout;
  /** 字号(CSS 像素):地图按 REF_MAP_CSS 像素宽显示、缩放 1 倍时的大小 */
  size: number;
  /** 放大地图时字号跟着长的幂:0 = 字号不变,0.5 = 放大 4 倍时字大 2 倍 */
  grow: number;
  /** 字距(字宽的倍数)[最小, 最大]。line / curve 在两者之间按路径长度取,river / point 用最小值 */
  tracking: [number, number];
  /** 从哪一级缩放开始显示 */
  minZoom: number;
  /** 越大越先放;放不下的低优先级文字不画 */
  priority: number;
  family: string;
  weight: number;
  color: string;
  /** 光晕(描边)。width 是 CSS 像素 */
  halo?: { color: string; width: number };
  /** 字向右倾斜(弧度),水系名用 */
  slant?: number;
  /** 字下面必须是什么地面(SURFACE 位掩码);不给 = 不限 */
  on?: number;
  /** point:放在正中时要求的地面;不给 = 不试正中 */
  inside?: number;
  /** river:半河宽;point:实体半径(世界单位)。放在旁边时要让开这么远 */
  radius?: number;
  /** line / curve 放不下时,是否再试"放在旁边"(按 radius,地面按 around) */
  around?: number;
  /** 允许多大比例的采样点落在不合要求的地面上(大片海名偶尔压到小岛);默认 0 */
  tolerance?: number;
  /**
   * 字号按世界单位给(国名:按国土拟合出来的大小)。给了就不看 size:
   * 实际字号 = sizeWorld × 地图每世界单位的 CSS 像素 × k^grow —— 缩放 1 倍时字和国土一起按地图大小缩放,正好铺满
   */
  sizeWorld?: number;
  /** 字必须落在这块区域里(世界坐标;国名 = 本国国土)。不在里面的采样点和地面不合要求的一起按 tolerance 算 */
  area?: (wx: number, wy: number) => boolean;
  /** 自己给候选摆法(画布像素;城名:围着自家符号的 8 个方位)。给了就不按 layout 排 */
  place?: (px: number, view: LabelView) => Candidate[];
  /** 所属符号(LabelMark.id):不和自家符号算重叠;自家符号没放上去,这条文字也不放 */
  mark?: number;
  /** 周围留白(字号的倍数);不给 = 按字距自动算(字距越大留得越多,见 personalSpace) */
  space?: number;
  /** 放这条时给另一条文字留好位置(国名给自家国都名):只挑放完以后它还放得下的摆法 */
  keepRoomFor?: LabelItem;
  /** 点选用(阶段 4):这条文字写的是哪个东西(国家 / 城 / 地理实体的编号)。排版不看它 */
  pick?: { kind: 'polity' | 'settlement' | 'place'; id: number };
  /** 弯边投影时 path 已经是地图平面坐标(国名按投影后的国土拟合的),不再投影;等距圆柱时不看 */
  planar?: boolean;
}

/**
 * 占位置的符号(城镇图标):和文字一起按 priority 排队,放上去以后别的文字、符号都要让开它。
 * 位置固定(世界坐标的一个点),大小按 CSS 像素给,随缩放按 k^grow 变大。
 */
export interface LabelMark {
  id: number;
  x: number;
  y: number;
  /** 外接框相对中心的偏移 [左, 上, 右, 下](CSS 像素,缩放 1 倍、地图按 REF_MAP_CSS 宽显示时) */
  box: [number, number, number, number];
  grow: number;
  minZoom: number;
  priority: number;
  /** 总要画(国都):不看重叠 */
  forced?: boolean;
  /** 缩放不到这一级时是"次要符号":排在所有文字之后放,和字挤在一起就不画(镇、村的名字还没出现时) */
  softBelow?: number;
  /** 和别的符号之间至少留多少空(CSS 像素);默认 1 */
  gap?: number;
}

export interface LabelView {
  /** 世界单位 → 画布像素:px = wx × scale + ox */
  scale: number;
  ox: number;
  oy: number;
  /** 画布像素 / CSS 像素 */
  dpr: number;
  /** 地图缩放倍数(1 = 整张图铺满) */
  k: number;
  /** k = 1 时地图显示多宽(CSS 像素) */
  mapCss: number;
  /** 世界大小(世界单位) */
  worldW: number;
  worldH: number;
  /** 地面查询(世界坐标):0 陆地 / 1 海 / 2 湖 / 3 陆上的河道;出界 -1 */
  surface?: (wx: number, wy: number) => number;
  /** 不许压字的区域(世界坐标 [x0, y0, x1, y1]),如手绘风的罗盘 */
  reserved?: [number, number, number, number][];
  /** 地图边框留白(世界单位),文字不出这个框 */
  margin?: number;
  /** 画布大小(画布像素):只放画布里(和附近)的符号;不给 = 不限 */
  canvasW?: number;
  canvasH?: number;
  /**
   * 世界东西相连的周期(世界单位,= 世界宽度);不给 / 0 = 不相连(单测里的小图)。
   * 给了的话视窗是"展开"的:世界 x 可以超出 [0, 宽),每条文字、每个符号挪整数圈,取离画布中心最近的那一份来排
   * (跨 180° 经线的国名、海名照常排成一条,不被切开)
   */
  wrap?: number;
  /**
   * 地图外框左边的世界 x(文字不出外框;默认 0)。外框画在视窗上、不随地图左右平移,
   * 外框 = [frameLeft, frameLeft + worldW] × [0, worldH](展开的世界坐标)
   */
  frameLeft?: number;
  /**
   * 弯边投影(罗宾森、摩尔威德……,见 render/projection.ts):世界坐标先投到"地图平面"(和世界一样大的长方形),
   * 再按 scale / ox / oy 到画布。不给 = 地图平面就是世界坐标(等距圆柱)。
   * 给了的话:路径加密后逐点投影(弯的投影里河名、山名顺着弯排),城镇符号的位置投过去,
   * 查地面、国土时从画布反投影回世界坐标;字不出投影的外轮廓(往里留 margin)。wrap 不再用(整张图就在画布上)
   */
  proj?: LabelProjection;
}

/** LabelView.proj:世界坐标 ↔ 地图平面 */
export interface LabelProjection {
  /** 世界 → 地图平面;refX = 经度按离它最近的那一圈连续展开(一条路径整条投过去,伸出外轮廓的部分落在轮廓外) */
  fwd(wx: number, wy: number, refX?: number): [number, number];
  /** 地图平面 → 世界;不在外轮廓里 = null */
  inv(mx: number, my: number): [number, number] | null;
  /** 地图平面上这一点在不在外轮廓里(往里缩 pad 个地图平面单位) */
  inside(mx: number, my: number, pad: number): boolean;
  /** 路径加密的步长(世界单位):比它长的一段中间插点再投影 */
  step: number;
  /** 世界东西相连的周期(世界单位):路径的 x 按相邻两点接着走 */
  wrap: number;
}

/** 世界坐标 → 画布像素(弯边投影按 view.proj 投过去;refX 见 LabelProjection.fwd) */
export function toCanvas(view: LabelView, wx: number, wy: number, refX?: number): [number, number] {
  if (view.proj) {
    const [mx, my] = view.proj.fwd(wx, wy, refX);
    return [mx * view.scale + view.ox, my * view.scale + view.oy];
  }
  return [wx * view.scale + view.ox, wy * view.scale + view.oy];
}

/** 画布像素 → 世界坐标(弯边投影时外轮廓外面 = null) */
export function fromCanvas(view: LabelView, x: number, y: number): [number, number] | null {
  const mx = (x - view.ox) / view.scale;
  const my = (y - view.oy) / view.scale;
  return view.proj ? view.proj.inv(mx, my) : [mx, my];
}

/**
 * 一条路径(世界坐标 x,y,x,y…)→ 画布像素。弯边投影时:相邻两点的 x 接着走(不横穿整张图),
 * 长的一段中间插点(按 proj.step),整条按路径中点连续投过去;planar = 路径已经是地图平面坐标(国名按投影后的国土拟合的)
 */
export function pathToCanvas(path: ArrayLike<number>, view: LabelView, planar = false): number[] {
  const out: number[] = [];
  const P = view.proj;
  if (!P || planar) {
    for (let i = 0; i + 1 < path.length; i += 2) out.push(path[i] * view.scale + view.ox, path[i + 1] * view.scale + view.oy);
    return out;
  }
  const n = path.length >> 1;
  if (!n) return out;
  const xs = new Float64Array(n);
  xs[0] = path[0];
  let lo = xs[0];
  let hi = xs[0];
  for (let i = 1; i < n; i++) {
    const v = path[2 * i];
    xs[i] = P.wrap ? v - P.wrap * Math.round((v - xs[i - 1]) / P.wrap) : v;
    if (xs[i] < lo) lo = xs[i];
    if (xs[i] > hi) hi = xs[i];
  }
  const ref = (lo + hi) / 2;
  const push = (x: number, y: number) => {
    const [mx, my] = P.fwd(x, y, ref);
    out.push(mx * view.scale + view.ox, my * view.scale + view.oy);
  };
  push(xs[0], path[1]);
  for (let i = 1; i < n; i++) {
    const ax = xs[i - 1];
    const ay = path[2 * i - 1];
    const bx = xs[i];
    const by = path[2 * i + 1];
    const m = Math.ceil(Math.hypot(bx - ax, by - ay) / P.step);
    for (let k = 1; k <= m; k++) push(ax + ((bx - ax) * k) / m, ay + ((by - ay) * k) / m);
  }
  return out;
}

/** 字号的参照:地图按这么宽(CSS 像素)显示时,LabelItem.size 就是实际字号 */
export const REF_MAP_CSS = 1300;
/** 最小字号(CSS 像素):中文再小就认不清了 */
export const MIN_LABEL_PX = 10.5;
const MIN_PX = MIN_LABEL_PX;
/** 次要符号(LabelMark.softBelow)的优先级:比所有文字都低 */
const SOFT_PRIORITY = -1e6;

export interface PlacedLabel {
  item: LabelItem;
  glyphs: Glyph[];
  /** 画布像素字号 */
  px: number;
  alpha: number;
}

/** 这条标注在当前视口下的字号(画布像素) */
export function labelPx(item: LabelItem, view: LabelView): number {
  const zoom = Math.pow(Math.max(1, view.k), item.grow);
  const css = item.sizeWorld !== undefined ? item.sizeWorld * (view.mapCss / view.worldW) * zoom : item.size * Math.sqrt(view.mapCss / REF_MAP_CSS) * zoom;
  return Math.max(MIN_PX, css) * view.dpr;
}

/** 符号在当前视口下的放大倍数:符号的 CSS 像素尺寸 × 这个数 = 画布像素 */
export function markScale(grow: number, view: LabelView): number {
  return Math.sqrt(view.mapCss / REF_MAP_CSS) * Math.pow(Math.max(1, view.k), grow) * view.dpr;
}

/** 符号的外接框(画布像素) */
export function markBox(m: LabelMark, view: LabelView): [number, number, number, number] {
  const s = markScale(m.grow, view);
  const [x, y] = toCanvas(view, m.x, m.y);
  return [x - m.box[0] * s, y - m.box[1] * s, x + m.box[2] * s, y + m.box[3] * s];
}

/** 已放上去的符号的外接框(画布像素;挪过整圈的也对) */
export function placedMarkBox(pm: PlacedMark): [number, number, number, number] {
  const b = pm.mark.box;
  return [pm.x - b[0] * pm.s, pm.y - b[1] * pm.s, pm.x + b[2] * pm.s, pm.y + b[3] * pm.s];
}

export interface PlacedMark {
  mark: LabelMark;
  /** 中心(画布像素) */
  x: number;
  y: number;
  /** 符号的 CSS 像素 → 画布像素 */
  s: number;
}

export interface Placement {
  labels: PlacedLabel[];
  marks: PlacedMark[];
}

/** 排版 + 避让(不画)。只有文字;返回放得下的标注,按绘制顺序 */
export function placeLabels(items: LabelItem[], view: LabelView): PlacedLabel[] {
  return placeMap(items, [], view).labels;
}

/**
 * 文字 + 符号一起排版避让(不画)。marks 和 items 按 priority 从高到低混排:
 * 先放的占住位置,后放的让开;符号只能在原处,放不下就不画(forced 的除外)。
 * 画布外面的符号不放(也就不画),它们的文字也跟着不放。
 */
export function placeMap(items: LabelItem[], marks: LabelMark[], view: LabelView): Placement {
  const W = view.worldW * view.scale;
  const H = view.worldH * view.scale;
  const m = (view.margin ?? 0) * view.scale;
  const fl = (view.frameLeft ?? 0) * view.scale;
  const X0 = view.ox + fl + m;
  const Y0 = view.oy + m;
  const X1 = view.ox + fl + W - m;
  const Y1 = view.oy + H - m;
  const viewOf = wrapViews(view);
  // 弯边投影:字不出外轮廓(往里留 margin),罗盘等在轮廓外面的东西不用另外让
  const P = view.proj;
  const inside = P ? (b: number[]) => {
    const pad = view.margin ?? 0;
    for (const [x, y] of [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]],
    ]) {
      if (!P.inside((x - view.ox) / view.scale, (y - view.oy) / view.scale, pad)) return false;
    }
    return true;
  } : null;
  const grid = new BoxGrid(Math.max(32, 48 * view.dpr));
  for (const r of view.reserved ?? []) {
    grid.add([r[0] * view.scale + view.ox, r[1] * view.scale + view.oy, r[2] * view.scale + view.ox, r[3] * view.scale + view.oy], -1);
  }
  // 视口(画布)范围再放宽一点:只放看得见的符号
  const cw = view.canvasW ?? Infinity;
  const ch = view.canvasH ?? Infinity;
  const slack = 60 * view.dpr;
  type Entry = { pri: number; i: number; it?: LabelItem; mk?: LabelMark };
  const order: Entry[] = [];
  items.forEach((it, i) => {
    if (view.k >= it.minZoom * 0.92 && it.text.length > 0) order.push({ pri: it.priority, i, it });
  });
  marks.forEach((mk, i) => {
    if (!(view.k >= mk.minZoom * 0.92)) return;
    const [x, y] = toCanvas(viewOf(mk.x), mk.x, mk.y);
    if (x < -slack || y < -slack || x > cw + slack || y > ch + slack) return;
    const soft = mk.softBelow !== undefined && view.k < mk.softBelow * 0.92;
    order.push({ pri: mk.forced ? Infinity : soft ? SOFT_PRIORITY : mk.priority, i: items.length + i, mk });
  });
  order.sort((a, b) => b.pri - a.pri || a.i - b.i);

  const out: PlacedLabel[] = [];
  const placedMarks: PlacedMark[] = [];
  const markOk = new Set<number>();
  for (const e of order) {
    if (e.mk) {
      const mk = e.mk;
      const mv = viewOf(mk.x);
      const b = markBox(mk, mv);
      const g = ((mk.gap ?? 1) * view.dpr) / 2;
      const pb = [b[0] - g, b[1] - g, b[2] + g, b[3] + g];
      if (!mk.forced && grid.hits(pb)) continue;
      grid.add(pb, mk.id);
      markOk.add(mk.id);
      const [mx, my] = toCanvas(mv, mk.x, mk.y);
      placedMarks.push({ mark: mk, x: mx, y: my, s: markScale(mk.grow, view) });
      continue;
    }
    const it = e.it!;
    if (it.mark !== undefined && !markOk.has(it.mark)) continue;
    const ch = tryPlace(it, null, true);
    if (!ch) continue;
    for (const g of ch.c.glyphs) grid.add(glyphBox(g, ch.px, ch.pad + ch.space), -1);
    const fade = it.minZoom <= 1 ? 1 : Math.min(1, Math.max(0, (view.k - it.minZoom * 0.92) / (it.minZoom * 0.1)));
    out.push({ item: it, glyphs: ch.c.glyphs, px: ch.px, alpha: fade });
  }

  interface Choice {
    c: Candidate;
    px: number;
    pad: number;
    space: number;
    bad: number;
  }
  /**
   * 给一条文字挑摆法:按候选顺序,第一个"不出框、不压已放的东西(和 extra 里的框)、地面合要求"的;
   * 地面不全合要求的,在允许的比例(tolerance)以内挑最好的。
   * room = true 且这条文字要给伙伴留位置(keepRoomFor,国名给国都名)时,只挑放完以后伙伴还放得下的摆法
   */
  function tryPlace(it: LabelItem, extra: number[][] | null, room: boolean): Choice | null {
    const own = it.mark ?? -1;
    // 东西相连:这条文字挪到离画布中心最近的那一圈(不相连时就是 view)
    const iv = viewOf(itemX(it));
    const px0 = labelPx(it, iv);
    const pad = (it.halo ? it.halo.width : 1) * view.dpr + 1.5 * view.dpr;
    const cands = it.place ? it.place(px0, iv) : candidates(it, iv, px0);
    const checks = !!(it.on || it.area);
    // 伙伴本来就放得下,才要求给它留位置(伙伴自己就放不下时,不连累这一条)
    const mate = room ? it.keepRoomFor : undefined;
    const mateOn =
      !!mate &&
      view.k >= mate.minZoom * 0.92 &&
      mate.text.length > 0 &&
      (mate.mark === undefined || markOk.has(mate.mark)) &&
      tryPlace(mate, null, false) !== null;
    let best: Choice | null = null;
    for (const c of cands) {
      const px = c.px ?? px0;
      const boxes = c.glyphs.map((g) => glyphBox(g, px, pad));
      if (boxes.some((b) => b[0] < X0 || b[1] < Y0 || b[2] > X1 || b[3] > Y1)) continue;
      if (inside && !boxes.every(inside)) continue;
      const space = (it.space !== undefined ? it.space * px : personalSpace(c.glyphs, px)) / 2;
      const mine = c.glyphs.map((g) => glyphBox(g, px, pad + space));
      if (mine.some((b) => grid.hits(b, own))) continue;
      if (extra && mine.some((b) => extra.some((o) => o[0] < b[2] && o[2] > b[0] && o[1] < b[3] && o[3] > b[1]))) continue;
      const bad = checks ? surfaceMisses(c, px, iv, it.area) : 0;
      if (bad > (it.tolerance ?? 0)) continue;
      const ch: Choice = { c, px, pad, space, bad };
      // 放了这条伙伴就没地方了:换下一个摆法;都不行就这次不放(小国的国名放大地图后再出现,国都名总在)
      if (mateOn && !tryPlace(mate!, mine, false)) continue;
      if (bad === 0) return ch;
      if (!best || bad < best.bad) best = ch;
    }
    return best;
  }
  return { labels: out, marks: placedMarks };
}

/** 标注在世界里的横向位置(路径 x 范围的中点;城名 = 自家符号的 x):东西相连时按它决定挪几圈 */
const itemXs = new WeakMap<LabelItem, number>();
function itemX(it: LabelItem): number {
  let x = itemXs.get(it);
  if (x !== undefined) return x;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 1 < it.path.length; i += 2) {
    const v = it.path[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  x = lo <= hi ? (lo + hi) / 2 : 0;
  itemXs.set(it, x);
  return x;
}

/**
 * 东西相连(view.wrap):世界 x = wx 的东西挪几圈、用哪个视口变换 —— 取离画布中心最近的那一份
 * (挪了 n 圈 = ox 加 n × 周期 × scale)。不相连时总是 view 本身
 */
function wrapViews(view: LabelView): (wx: number) => LabelView {
  const P = view.wrap ?? 0;
  if (!P || view.proj) return () => view;
  // 画布中心的世界 x(不知道画布多大时用外框中心)
  const center = view.canvasW !== undefined ? (view.canvasW / 2 - view.ox) / view.scale : (view.frameLeft ?? 0) + view.worldW / 2;
  const byN = new Map<number, LabelView>([[0, view]]);
  return (wx: number) => {
    const n = Math.round((center - wx) / P);
    let v = byN.get(n);
    if (!v) byN.set(n, (v = { ...view, ox: view.ox + n * P * view.scale }));
    return v;
  };
}

/**
 * 画地图文字。ctx 是视口文字层的画布(调用前已清空);items 里的坐标是世界单位。
 * 返回实际画了几条。
 */
export function drawLabels(ctx: CanvasRenderingContext2D, items: LabelItem[], view: LabelView): number {
  const placed = placeLabels(items, view);
  drawPlacedLabels(ctx, placed, view);
  return placed.length;
}

/**
 * 画已经排好的文字(placeMap / placeLabels 的结果)。
 * glyphAlpha:每个字再乘一个不透明度(地球仪上靠近球边缘的字淡出);不给 = 都是 1
 */
export function drawPlacedLabels(ctx: CanvasRenderingContext2D, placed: PlacedLabel[], view: LabelView, glyphAlpha?: (g: Glyph) => number): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // 先画低优先级的,重要的字压在上面(反正不重叠,只影响光晕交界)
  for (let i = placed.length - 1; i >= 0; i--) {
    const { item, glyphs, px, alpha } = placed[i];
    if (alpha <= 0.01) continue;
    // 整条都在画布外就跳过
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    if (glyphs.every((g) => g.x < -px || g.y < -px || g.x > cw + px || g.y > ch + px)) continue;
    ctx.globalAlpha = alpha;
    ctx.font = fontCss(item.family, item.weight, px);
    const sk = item.slant ? -Math.tan(item.slant) : 0;
    // 中文字形在 em 框里略偏上,往下挪一点让视觉中心落在锚点上
    const dy = px * 0.04;
    if (item.halo && item.halo.width > 0) {
      ctx.strokeStyle = item.halo.color;
      ctx.lineWidth = item.halo.width * 2 * view.dpr;
      for (const g of glyphs) {
        if (glyphAlpha) ctx.globalAlpha = alpha * glyphAlpha(g);
        glyphTransform(ctx, g, sk);
        ctx.strokeText(g.ch, 0, dy);
      }
    }
    ctx.fillStyle = item.color;
    for (const g of glyphs) {
      if (glyphAlpha) ctx.globalAlpha = alpha * glyphAlpha(g);
      glyphTransform(ctx, g, sk);
      ctx.fillText(g.ch, 0, dy);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.restore();
}

function glyphTransform(ctx: CanvasRenderingContext2D, g: Glyph, sk: number) {
  const c = Math.cos(g.a);
  const s = Math.sin(g.a);
  // 平移 → 旋转 → 斜切
  ctx.setTransform(c, s, -s, c, g.x, g.y);
  if (sk) ctx.transform(1, 0, sk, 1, 0, 0);
}

/** 生成候选摆法(画布像素) */
function candidates(it: LabelItem, view: LabelView, px: number): Candidate[] {
  const pts = pathToCanvas(it.path, view, it.planar);
  if (!pts.length) return [];
  const on = it.on ?? 0;
  const path = new Polyline(pts);
  // 半径是世界单位:弯边投影时按这条路径中点处的局部比例换成地图平面单位
  const r = (it.radius ?? 0) * view.scale * (view.proj && it.path.length >= 2 && !it.planar ? localScale(view.proj, it.path) : 1);
  let out: Candidate[];
  switch (it.layout) {
    case 'line':
      out = layoutLine(it.text, path, px, it.tracking, on);
      break;
    case 'curve':
      out = layoutCurve(it.text, path, px, it.tracking, on);
      break;
    case 'river':
      out = layoutRiver(it.text, path, px, it.tracking, r, on).filter((c) => clearOf(c, path, r + px * 0.45));
      break;
    case 'point': {
      const [cx, cy] = path.at(path.length / 2);
      return layoutPoint(it.text, cx, cy, r, px, it.tracking, it.inside ?? 0, on);
    }
  }
  if (it.around !== undefined && it.radius !== undefined) {
    const [cx, cy] = path.at(path.length / 2);
    out = out.concat(layoutPoint(it.text, cx, cy, r, px, [it.tracking[0], it.tracking[0]], 0, it.around));
  }
  return out;
}

/** 弯边投影在路径中点处的局部比例(地图平面单位 / 世界单位,横竖取几何平均) */
function localScale(P: LabelProjection, path: ArrayLike<number>): number {
  const n = path.length >> 1;
  const i = (n >> 1) * 2;
  const x = path[i];
  const y = path[i + 1];
  const [x0, y0] = P.fwd(x, y, x);
  const [x1, y1] = P.fwd(x + 1, y, x);
  const [x2, y2] = P.fwd(x, y + 1, x);
  const k = Math.sqrt(Math.hypot(x1 - x0, y1 - y0) * Math.hypot(x2 - x0, y2 - y0));
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/**
 * 一条标注周围要空出多少(画布像素):至少半个字,字距拉得越开的空得越多 ——
 * 不然两条字距很大的名字挨着排,读起来像一个长名字。两条标注之间的空隙 = 各自的一半之和。
 */
function personalSpace(glyphs: Glyph[], px: number): number {
  if (glyphs.length < 2) return px * 0.6;
  const gaps: number[] = [];
  for (let i = 1; i < glyphs.length; i++) gaps.push(Math.hypot(glyphs[i].x - glyphs[i - 1].x, glyphs[i].y - glyphs[i - 1].y) - px);
  gaps.sort((a, b) => a - b);
  const gap = Math.max(0, gaps[gaps.length >> 1]);
  return Math.min(px * 3, Math.max(px * 0.6, gap * 1.1 + px * 0.5));
}

/** 河名的字不能压到河道本身(河拐回来的地方) */
function clearOf(c: Candidate, path: Polyline, min: number): boolean {
  return c.glyphs.every((g) => path.distance(g.x, g.y) >= min);
}

/** 每个字在方框内取 9 个点查地面(和区域 area),返回不合要求的点所占比例;字的中心不在区域里 = Infinity */
function surfaceMisses(c: Candidate, px: number, view: LabelView, area?: (wx: number, wy: number) => boolean): number {
  const f = c.on ? view.surface : undefined;
  if (!f && !area) return 0;
  const h = px * 0.46;
  let bad = 0;
  let total = 0;
  for (const g of c.glyphs) {
    const cs = Math.cos(g.a);
    const sn = Math.sin(g.a);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const lx = a * h;
        const ly = b * h;
        const x = g.x + lx * cs - ly * sn;
        const y = g.y + lx * sn + ly * cs;
        total++;
        const w = fromCanvas(view, x, y);
        if (!w) {
          // 弯边投影:落在外轮廓外面
          if (area && a === 0 && b === 0) return Infinity;
          bad++;
          continue;
        }
        const [wx, wy] = w;
        if (f) {
          const s = f(wx, wy);
          if (s < 0 || !(c.on & (1 << s))) {
            bad++;
            continue;
          }
        }
        if (area && !area(wx, wy)) {
          // 字的中心一定要在区域里(国名的每个字都落在本国国土上),四角允许少量出界
          if (a === 0 && b === 0) return Infinity;
          bad++;
        }
      }
    }
  }
  return total ? bad / total : 0;
}

/**
 * 已放文字、符号的外接框,按网格分桶查重叠。每个框带一个标记(第 5 个数):符号 = 符号编号,文字 = −1,
 * 查重叠时可以跳过某个符号自己的框(城名不和自家符号算重叠)
 */
class BoxGrid {
  private cells = new Map<number, number[][]>();
  constructor(private size: number) {}
  private key(x: number, y: number) {
    return (Math.floor(y / this.size) + 4096) * 8192 + (Math.floor(x / this.size) + 4096);
  }
  add(b0: number[], tag: number) {
    const b = [b0[0], b0[1], b0[2], b0[3], tag];
    const s = this.size;
    for (let y = Math.floor(b[1] / s); y <= Math.floor(b[3] / s); y++) {
      for (let x = Math.floor(b[0] / s); x <= Math.floor(b[2] / s); x++) {
        const k = this.key(x * s, y * s);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(b);
      }
    }
  }
  /** 和已放的框重叠吗(标记为 ignore 的符号框不算;ignore < 0 = 都算) */
  hits(b: number[], ignore = -1): boolean {
    const s = this.size;
    for (let y = Math.floor(b[1] / s); y <= Math.floor(b[3] / s); y++) {
      for (let x = Math.floor(b[0] / s); x <= Math.floor(b[2] / s); x++) {
        const l = this.cells.get(this.key(x * s, y * s));
        if (!l) continue;
        for (const o of l) {
          if (ignore >= 0 && o[4] === ignore) continue;
          if (o[0] < b[2] && o[2] > b[0] && o[1] < b[3] && o[3] > b[1]) return true;
        }
      }
    }
    return false;
  }
}
