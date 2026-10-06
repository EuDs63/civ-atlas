/**
 * 地球仪上的文字:和平面主图同一套排版(render/labels/draw.ts 的 placeMap)—— 山名沿山脊排、河名逐字正立沿河排、
 * 国名大字疏排顺着国土、城名在符号旁 8 个方位里挑、海名疏排,一起按优先级避让、按缩放分级出现。
 *
 * 做法:给 placeMap 一个"投影"(LabelView.proj),把世界坐标换成球上正射投影后的屏幕位置。
 *   - 地图平面 = 画布像素按 scale 缩一下(scale = 球心处一个世界单位的画布像素),外框是以球心为中心、
 *     2πR × πR 的长方形 —— 总能罩住整个球,真正的边界由 inside 管:字的每个角都在球面上、离球的轮廓还有一点距离、在画布里
 *   - 路径每约 2° 加密一个点再逐点投影(弯的地方跟着弯排)
 *   - 背面的点"翻"到球的轮廓外面去(离轮廓越远 = 越靠背面):路径从正面走到背面是连续的一条,
 *     落在背面的那一截排不上字(inside 不认),不会在正面叠出一段假的路径
 *   - 查地面(海名在水上、山名在陆上……)、查国土时从画布反投影回世界坐标
 * 靠近球边缘的字按每个字的朝向淡出(glyphAlpha);城镇符号只放朝着观察者的。
 */
import { MIN_LABEL_PX, REF_MAP_CSS, SURFACE, markScale, pathToCanvas, type LabelItem, type LabelMark, type LabelProjection, type LabelView } from './labels/draw';
import { Polyline, type Candidate, type Glyph } from './labels/layout';
import { equivalentZoom, globeBasis, globeFrame, type GlobeView } from './globe';

const PI = Math.PI;
const TAU = 2 * Math.PI;

/** 字的每个角离球心最远多少(球的半径的倍数):朝向 ≥ GLYPH_MIN_D(视线和球面的夹角不太小) */
export const GLYPH_MIN_D = 0.07;
const RMAX2 = 1 - GLYPH_MIN_D * GLYPH_MIN_D;
/** 城镇符号的朝向下限 */
export const MARK_MIN_D = 0.1;

export type Box = [number, number, number, number];

export interface GlobeLabelInput {
  view: GlobeView;
  /** 画布大小(CSS 像素)、像素密度 */
  w: number;
  h: number;
  dpr: number;
  worldW: number;
  worldH: number;
  /** 地面查询(labelViewExtras 的 surface) */
  surface?: LabelView['surface'];
  /** 不许压字的地方(按钮、时间轴;CSS 像素) */
  reserved?: readonly Box[];
  /** 球心横向挪了多少(CSS 像素;宽屏左边有侧栏卡片时往右,见 globe.ts 的 globeFrame) */
  shift?: number;
  /** 球心、半径(CSS 像素)直接给定(不按 globeFrame 摆;新建界面的星球) */
  frame?: { cx: number; cy: number; R: number };
}

/** 地球仪的 LabelView,再带上画布像素下的球(球心、半径)和视图方向,画的时候、筛符号时用 */
export interface GlobeLabelView extends LabelView {
  globe: {
    cx: number;
    cy: number;
    R: number;
    c: [number, number, number];
    e: [number, number, number];
    n: [number, number, number];
    /** 等效的主图缩放倍数(显示门槛、字号按它) */
    kEq: number;
  };
}

/** 画布像素的一点离球心多远(球的半径的倍数)→ 朝向;球外 = −1 */
function facing(g: GlobeLabelView['globe'], x: number, y: number): number {
  const u = (x - g.cx) / g.R;
  const t = (y - g.cy) / g.R;
  const r2 = u * u + t * t;
  return r2 > 1 ? -1 : Math.sqrt(1 - r2);
}

export function globeLabelView(o: GlobeLabelInput): GlobeLabelView {
  const { view, w, h, dpr, worldW: W, worldH: H } = o;
  const f = o.frame ?? globeFrame(view, w, h, o.shift ?? 0);
  const cx = f.cx * dpr;
  const cy = f.cy * dpr;
  const R = f.R * dpr;
  const { c, e, n } = globeBasis(view.lon, view.lat);
  const kEq = equivalentZoom(f.R, REF_MAP_CSS);
  // 地图平面:球心处一个世界单位 = scale 个画布像素;外框(W × H 个世界单位)以球心为中心
  const scale = (TAU * R) / W;
  const ox = cx - (W * scale) / 2;
  const oy = cy - (H * scale) / 2;
  const cw = Math.max(1, Math.round(w * dpr));
  const ch = Math.max(1, Math.round(h * dpr));
  const edge = 2 * dpr;
  const proj: LabelProjection = {
    fwd(wx, wy) {
      const lon = (wx / W) * TAU - PI;
      const lat = PI / 2 - (wy / H) * PI;
      const cl = Math.cos(lat);
      const px = cl * Math.cos(lon);
      const py = cl * Math.sin(lon);
      const pz = Math.sin(lat);
      const d = px * c[0] + py * c[1] + pz * c[2];
      let X = px * e[0] + py * e[1] + pz * e[2];
      let Y = px * n[0] + py * n[1] + pz * n[2];
      if (d < 0) {
        // 背面:翻到轮廓外面(到对跖点时离球心两个半径),路径照样连续
        const r = Math.sqrt(X * X + Y * Y);
        if (r < 1e-9) {
          X = 2;
          Y = 0;
        } else {
          const k = (2 - r) / r;
          X *= k;
          Y *= k;
        }
      }
      return [(cx + R * X - ox) / scale, (cy - R * Y - oy) / scale];
    },
    inv(mx, my) {
      const u = (mx * scale + ox - cx) / R;
      const t = (cy - (my * scale + oy)) / R;
      const r2 = u * u + t * t;
      if (!(r2 <= 1)) return null;
      const wv = Math.sqrt(1 - r2);
      const x = u * e[0] + t * n[0] + wv * c[0];
      const y = u * e[1] + t * n[1] + wv * c[1];
      const z = u * e[2] + t * n[2] + wv * c[2];
      const lon = Math.atan2(y, x);
      const lat = Math.asin(Math.max(-1, Math.min(1, z)));
      let wx = ((lon + PI) / TAU) * W;
      if (wx >= W) wx -= W;
      return [wx, ((PI / 2 - lat) / PI) * H];
    },
    inside(mx, my) {
      const x = mx * scale + ox;
      const y = my * scale + oy;
      if (x < edge || y < edge || x > cw - edge || y > ch - edge) return false;
      const u = (x - cx) / R;
      const t = (y - cy) / R;
      return u * u + t * t <= RMAX2;
    },
    step: W / 180,
    wrap: W,
  };
  const toPlane = (b: Box): [number, number, number, number] => [
    (b[0] * dpr - ox) / scale,
    (b[1] * dpr - oy) / scale,
    (b[2] * dpr - ox) / scale,
    (b[3] * dpr - oy) / scale,
  ];
  return {
    scale,
    ox,
    oy,
    dpr,
    k: kEq,
    mapCss: REF_MAP_CSS,
    worldW: W,
    worldH: H,
    surface: o.surface,
    reserved: (o.reserved ?? []).map(toPlane),
    margin: 0,
    canvasW: cw,
    canvasH: ch,
    wrap: 0,
    frameLeft: 0,
    proj,
    globe: { cx, cy, R, c, e, n, kEq },
  };
}

/** 每个字的不透明度:靠近球边缘(视线擦着球面)的淡出 */
export function globeGlyphAlpha(lv: GlobeLabelView): (g: Glyph) => number {
  const g0 = lv.globe;
  return (g: Glyph) => {
    const d = facing(g0, g.x, g.y);
    const t = Math.min(1, Math.max(0, (d - GLYPH_MIN_D) / (0.3 - GLYPH_MIN_D)));
    return 0.15 + 0.85 * t * t * (3 - 2 * t);
  };
}

/**
 * 城镇符号:只留朝着观察者(朝向 ≥ MARK_MIN_D)、在画布附近、不压按钮和时间轴(国都也不压)的;返回留下的符号和它们的朝向。
 * 靠近球边缘的地方被压扁了(比例尺在朝着球边缘的方向上只有 d 倍):出现门槛按"这里的等效缩放" kEq·√d 算,
 * 小镇、村子不会在球边缘挤成一圈(国都照样画)
 */
export function visibleMarks<M extends LabelMark>(marks: readonly M[], lv: GlobeLabelView): { marks: M[]; facing: Map<number, number> } {
  const P = lv.proj!;
  const out: M[] = [];
  const fac = new Map<number, number>();
  const slack = 40 * lv.dpr;
  const reserved = (lv.reserved ?? []).map((r) => [r[0] * lv.scale + lv.ox, r[1] * lv.scale + lv.oy, r[2] * lv.scale + lv.ox, r[3] * lv.scale + lv.oy]);
  for (const m of marks) {
    if (!(lv.k >= m.minZoom * 0.92)) continue;
    const [mx, my] = P.fwd(m.x, m.y);
    const x = mx * lv.scale + lv.ox;
    const y = my * lv.scale + lv.oy;
    // 背面的点翻到了轮廓外面,facing 是 −1
    const d = facing(lv.globe, x, y);
    if (d < MARK_MIN_D || x < -slack || y < -slack || x > (lv.canvasW ?? Infinity) + slack || y > (lv.canvasH ?? Infinity) + slack) continue;
    if (!m.forced && !(lv.k * Math.sqrt(d) >= m.minZoom * 0.92)) continue;
    const s = markScale(m.grow, lv);
    const b = [x - m.box[0] * s, y - m.box[1] * s, x + m.box[2] * s, y + m.box[3] * s];
    if (reserved.some((r) => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1])) continue;
    out.push(m);
    fac.set(m.id, d);
  }
  return { marks: out, facing: fac };
}

/** 世界坐标的一点在不在球的正面(朝向 > 0),和它在画布上的位置 */
export function globeToCanvas(lv: GlobeLabelView, wx: number, wy: number): [number, number, number] {
  const W = lv.worldW;
  const H = lv.worldH;
  const lon = (wx / W) * TAU - PI;
  const lat = PI / 2 - (wy / H) * PI;
  const cl = Math.cos(lat);
  const px = cl * Math.cos(lon);
  const py = cl * Math.sin(lon);
  const pz = Math.sin(lat);
  const { c, e, n, cx, cy, R } = lv.globe;
  const d = px * c[0] + py * c[1] + pz * c[2];
  return [cx + R * (px * e[0] + py * e[1] + pz * e[2]), cy - R * (px * n[0] + py * n[1] + pz * n[2]), d];
}

const polityItems = new WeakMap<LabelItem, LabelItem>();
/** 国名放不下时再试的字号(相对原字号)、沿路径的位置 */
const UPRIGHT_SIZES = [0.86, 0.74, 0.62];
const UPRIGHT_AT = [0.5, 0.36, 0.64, 0.22, 0.78];

/**
 * 地球仪上的国名:沿国土拟合的路径排(和主图一样)之外,再多几个"横排、紧一点、小一两档"的摆法 ——
 * 国名是按主图(等距圆柱)上的国土拟合的,到了球上高纬度的国家变窄、靠近球边缘的国家被压扁,
 * 原来的字距、字号常常排不下;多给几个摆法,照样要求每个字落在本国国土上(placeMap 按 area 核对)
 */
export function globePolityItem(it: LabelItem): LabelItem {
  if (it.pick?.kind !== 'polity' || !it.place) return it;
  let g = polityItems.get(it);
  if (!g) {
    const orig = it.place;
    g = { ...it, place: (px, view) => orig(px, view).concat(uprightRows(it, px, view)) };
    polityItems.set(it, g);
  }
  return g;
}

function uprightRows(it: LabelItem, px0: number, view: LabelView): Candidate[] {
  const path = new Polyline(pathToCanvas(it.path, view, it.planar));
  const cs = [...it.text];
  const n = cs.length;
  if (!n || !path.xs.length) return [];
  const min = MIN_LABEL_PX * view.dpr;
  const out: Candidate[] = [];
  let last = 0;
  for (const f of UPRIGHT_SIZES) {
    const px = Math.max(min, px0 * f);
    if (px === last) continue;
    last = px;
    const pitch = px * 1.3;
    for (const t of UPRIGHT_AT) {
      const [cx, cy] = path.at(path.length * t);
      out.push({ on: 0, px, glyphs: cs.map((ch, i): Glyph => ({ ch, x: cx + (i - (n - 1) / 2) * pitch, y: cy, a: 0 })) });
    }
  }
  return out;
}

/**
 * 转动 / 拖时间轴时只排的"大字":国名、大洋和海(总览级的)、国都和大城的名字 ——
 * 山名、河名、湖名、岛名、小城名停下来约 0.15 秒后再排(排得多、要查地面,拖动时每帧都排会卡)
 */
export function isQuickLabel(it: LabelItem): boolean {
  const pk = it.pick?.kind;
  if (pk === 'polity') return true;
  if (pk === 'settlement') return it.priority >= 89;
  if (pk === 'place') return it.layout === 'line' && it.on === SURFACE.sea && it.minZoom <= 1;
  return false;
}
