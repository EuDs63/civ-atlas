/**
 * 地球仪上的矢量线:国界、道路与航线、选中的国家 / 州的描边、选中的大河 / 山脉的淡光。
 *
 * 平面主图上这些线是烤在文明底图里的像素,贴到球上放大三倍以上就发软;地球仪上改成每帧按正射投影逐顶点画在
 * 球上面那层 2D 画布里:
 *   - 线宽、虚线的节奏按屏幕像素定(粗细和平面主图"同样的缩放"时一致,放大以后不再变粗),放大到 8 倍也锐利
 *   - 顶点先换成三维单位向量(每年的线只换一次),每帧只做三次点乘:跨 180° 经线没有接缝,线自然连着
 *   - 背面的裁掉:线从正面走到背面时在球的轮廓上断开(按三维线段和"视线垂直的大圆"的交点)
 *   - 分块剔除:每 CHUNK 个顶点一块,记下块的中心和半径;整块在背面、整块在屏幕外的不投影
 *   - 屏幕上挨得太近(不到 MIN_SEG 像素)的顶点合并,整球视图下的顶点数少一大半
 *   - 靠近球边缘的线淡一点(和贴图边缘的暗角、大气光一致),见 fadeRim
 * 手绘风国界"每一笔粗细不一":按位置分三档粗细(和平面主图 inkDashes 同一个公式),每档一条线、虚线按屏幕像素。
 *
 * 纯计算的部分(建线、投影、裁剪)单测在 Node 里跑;画只用到 moveTo / lineTo / stroke。
 */
import type { Polyline } from './civ/lines';
import type { SidedLine } from './civ/borders';
import { inkPen } from './civ/borders';
import type { CivStyle } from './civ/overlay';
import { globeBasis, type GlobeFrame, type GlobeView } from './globe';

const PI = Math.PI;
const TAU = 2 * Math.PI;

/** 一块多少个顶点(剔除的粒度) */
export const CHUNK = 48;
/** 屏幕上相邻两个顶点至少隔这么远(画布像素)才各画一个 */
const MIN_SEG = 0.9;

/** 三角函数表的格数:经度一整圈 / 纬度从北极到南极各分这么多格 */
const TRIG_N = 8192;
let trigTable: { cosLon: Float64Array; sinLon: Float64Array; cosLat: Float64Array; sinLat: Float64Array } | null = null;

/** 世界 x 的一整圈(经度 −180°…180°)、世界 y 从上到下(纬度 90°…−90°)的 cos / sin 表(多一格,插值到最后一格也不越界) */
function trig() {
  if (!trigTable) {
    const cosLon = new Float64Array(TRIG_N + 1);
    const sinLon = new Float64Array(TRIG_N + 1);
    const cosLat = new Float64Array(TRIG_N + 1);
    const sinLat = new Float64Array(TRIG_N + 1);
    for (let i = 0; i <= TRIG_N; i++) {
      const lon = (i / TRIG_N) * TAU - PI;
      const lat = PI / 2 - (i / TRIG_N) * PI;
      cosLon[i] = Math.cos(lon);
      sinLon[i] = Math.sin(lon);
      cosLat[i] = Math.cos(lat);
      sinLat[i] = Math.sin(lat);
    }
    trigTable = { cosLon, sinLon, cosLat, sinLat };
  }
  return trigTable;
}

/** 一组线,顶点换成了三维单位向量,分好块 */
export interface GlobeLineSet {
  /** 顶点 x,y,z… */
  xyz: Float32Array;
  /** 块 j 的顶点 [start[j], end[j]](含两端;同一条线相邻两块共用端点);first[j] = 1:这一块是一条线的开头 */
  start: Int32Array;
  end: Int32Array;
  first: Uint8Array;
  /** 块的中心(单位向量 x,y,z…)和半径(块里的顶点离中心的直线距离都不超过它) */
  center: Float32Array;
  radius: Float32Array;
  chunks: number;
  vertices: number;
}

/**
 * 世界坐标的折线(x 已展开、可以伸出主图左右边)→ 三维顶点 + 分块。
 * 长的一段中间插点(maxStep 世界单位,默认约 2°):投影后弯的线照样顺
 */
export function buildLineSet(lines: readonly { pts: ArrayLike<number> }[], W: number, H: number, maxStep = W / 180): GlobeLineSet {
  // 先数一共多少个顶点(含插的点),一次分配好
  let total = 0;
  for (const l of lines) {
    const p = l.pts;
    const n = p.length >> 1;
    if (n < 2) continue;
    total++;
    for (let i = 1; i < n; i++) total += Math.max(1, Math.ceil(Math.sqrt((p[2 * i] - p[2 * i - 2]) ** 2 + (p[2 * i + 1] - p[2 * i - 1]) ** 2) / maxStep));
  }
  const xyz = new Float32Array(total * 3);
  const T = trig();
  let o = 0;
  // 世界坐标 → 单位向量(三角函数查表 + 线性插值;误差不到 1e-7,放大 8 倍也远不到一个像素)
  const push = (x: number, y: number) => {
    let u = (x / W) * TRIG_N;
    u -= TRIG_N * Math.floor(u / TRIG_N);
    const i = u | 0;
    const f = u - i;
    const co = T.cosLon[i] + (T.cosLon[i + 1] - T.cosLon[i]) * f;
    const so = T.sinLon[i] + (T.sinLon[i + 1] - T.sinLon[i]) * f;
    let v = (y / H) * TRIG_N;
    v = v < 0 ? 0 : v > TRIG_N ? TRIG_N : v;
    const j = Math.min(TRIG_N - 1, v | 0);
    const g = v - j;
    const cl = T.cosLat[j] + (T.cosLat[j + 1] - T.cosLat[j]) * g;
    const sl = T.sinLat[j] + (T.sinLat[j + 1] - T.sinLat[j]) * g;
    xyz[o++] = cl * co;
    xyz[o++] = cl * so;
    xyz[o++] = sl;
  };
  const ranges: number[] = [];
  for (const l of lines) {
    const p = l.pts;
    const n = p.length >> 1;
    if (n < 2) continue;
    const a = o / 3;
    push(p[0], p[1]);
    for (let i = 1; i < n; i++) {
      const ax = p[2 * i - 2];
      const ay = p[2 * i - 1];
      const bx = p[2 * i];
      const by = p[2 * i + 1];
      const m = Math.max(1, Math.ceil(Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2) / maxStep));
      for (let k = 1; k <= m; k++) push(ax + ((bx - ax) * k) / m, ay + ((by - ay) * k) / m);
    }
    ranges.push(a, o / 3 - 1);
  }
  const start: number[] = [];
  const end: number[] = [];
  const first: number[] = [];
  for (let r = 0; r < ranges.length; r += 2) {
    const a = ranges[r];
    const b = ranges[r + 1];
    for (let s = a; s < b; ) {
      const e = Math.min(s + CHUNK, b);
      start.push(s);
      end.push(e);
      first.push(s === a ? 1 : 0);
      s = e;
    }
  }
  const chunks = start.length;
  const center = new Float32Array(chunks * 3);
  const radius = new Float32Array(chunks);
  for (let j = 0; j < chunks; j++) {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = start[j]; i <= end[j]; i++) {
      sx += xyz[3 * i];
      sy += xyz[3 * i + 1];
      sz += xyz[3 * i + 2];
    }
    let l = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (l < 1e-9) {
      // 退化(顶点正好对称分布):拿第一个顶点当中心,半径取到最大
      sx = xyz[3 * start[j]];
      sy = xyz[3 * start[j] + 1];
      sz = xyz[3 * start[j] + 2];
      l = 1;
    }
    sx /= l;
    sy /= l;
    sz /= l;
    let r2 = 0;
    for (let i = start[j]; i <= end[j]; i++) {
      const d2 = (xyz[3 * i] - sx) ** 2 + (xyz[3 * i + 1] - sy) ** 2 + (xyz[3 * i + 2] - sz) ** 2;
      if (d2 > r2) r2 = d2;
    }
    center[3 * j] = sx;
    center[3 * j + 1] = sy;
    center[3 * j + 2] = sz;
    // float32 存的顶点有一点误差:半径放宽一点点
    radius[j] = Math.sqrt(r2) * 1.0001 + 1e-6;
  }
  return { xyz, start: Int32Array.from(start), end: Int32Array.from(end), first: Uint8Array.from(first), center, radius, chunks, vertices: xyz.length / 3 };
}

/** 一帧的投影参数(画布像素):球心、半径、画布大小、视图的三个方向 */
export interface GlobeProjector {
  cx: number;
  cy: number;
  R: number;
  w: number;
  h: number;
  c: [number, number, number];
  e: [number, number, number];
  n: [number, number, number];
}

/** frame 用什么像素单位,投影出来的就是什么单位(一般用画布像素) */
export function globeProjector(view: GlobeView, f: GlobeFrame): GlobeProjector {
  const { c, e, n } = globeBasis(view.lon, view.lat);
  return { cx: f.cx, cy: f.cy, R: f.R, w: f.w, h: f.h, c, e, n };
}

/** 只要 moveTo / lineTo(CanvasRenderingContext2D、Path2D、单测里的记录器都行) */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

/**
 * 把一组线按正射投影描进 path:背面裁掉(在球的轮廓上断开),整块在背面 / 屏幕外(再放宽 pad 像素)的跳过,
 * 屏幕上挨得太近的顶点合并。返回描了多少个点
 */
export function traceLineSet(path: PathSink, set: GlobeLineSet, P: GlobeProjector, pad = 8): number {
  const { xyz, start, end, first, center, radius } = set;
  const [cx0, cx1, cx2] = P.c;
  const [ex0, ex1, ex2] = P.e;
  const [nx0, nx1, nx2] = P.n;
  const { cx, cy, R, w, h } = P;
  const min2 = MIN_SEG * MIN_SEG;
  let pen = false;
  let havePrev = false;
  let ax = 0;
  let ay = 0;
  let az = 0;
  let ad = 0;
  let lx = 0;
  let ly = 0;
  let qx = 0;
  let qy = 0;
  let pending = false;
  let count = 0;
  const flush = () => {
    if (pen && pending) {
      path.lineTo(qx, qy);
      count++;
    }
    pending = false;
    pen = false;
    havePrev = false;
  };
  // 从 a(朝向 da)到 b(朝向 db)的线段和轮廓的交点(两者朝向异号),投到屏幕
  const rim = (bx: number, by: number, bz: number, db: number): [number, number] => {
    const t = ad / (ad - db);
    let hx = ax + (bx - ax) * t;
    let hy = ay + (by - ay) * t;
    let hz = az + (bz - az) * t;
    const l = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
    hx /= l;
    hy /= l;
    hz /= l;
    return [cx + R * (hx * ex0 + hy * ex1 + hz * ex2), cy - R * (hx * nx0 + hy * nx1 + hz * nx2)];
  };
  for (let j = 0; j < set.chunks; j++) {
    if (first[j]) flush();
    const mx = center[3 * j];
    const my = center[3 * j + 1];
    const mz = center[3 * j + 2];
    const r = radius[j];
    const md = mx * cx0 + my * cx1 + mz * cx2;
    if (md + r < 0) {
      flush();
      continue;
    }
    const sx = cx + R * (mx * ex0 + my * ex1 + mz * ex2);
    const sy = cy - R * (mx * nx0 + my * nx1 + mz * nx2);
    const rr = R * r + pad;
    if (sx + rr < 0 || sx - rr > w || sy + rr < 0 || sy - rr > h) {
      flush();
      continue;
    }
    // 接着上一块:这一块的第一个顶点就是上一块的最后一个,已经处理过
    for (let i = havePrev ? start[j] + 1 : start[j]; i <= end[j]; i++) {
      const x = xyz[3 * i];
      const y = xyz[3 * i + 1];
      const z = xyz[3 * i + 2];
      const d = x * cx0 + y * cx1 + z * cx2;
      if (d >= 0) {
        const px = cx + R * (x * ex0 + y * ex1 + z * ex2);
        const py = cy - R * (x * nx0 + y * nx1 + z * nx2);
        if (!pen) {
          if (havePrev) {
            // 从背面转过来:从轮廓上起笔
            const [hx, hy] = rim(x, y, z, d);
            path.moveTo(hx, hy);
            path.lineTo(px, py);
            count += 2;
          } else {
            path.moveTo(px, py);
            count++;
          }
          lx = px;
          ly = py;
          pending = false;
          pen = true;
        } else {
          const dx = px - lx;
          const dy = py - ly;
          if (dx * dx + dy * dy < min2) {
            qx = px;
            qy = py;
            pending = true;
          } else {
            path.lineTo(px, py);
            count++;
            lx = px;
            ly = py;
            pending = false;
          }
        }
      } else if (pen) {
        // 转到背面去:画到轮廓上收笔
        if (pending) {
          path.lineTo(qx, qy);
          count++;
          pending = false;
        }
        const [hx, hy] = rim(x, y, z, d);
        path.lineTo(hx, hy);
        count++;
        pen = false;
      }
      ax = x;
      ay = y;
      az = z;
      ad = d;
      havePrev = true;
    }
  }
  flush();
  return count;
}

// ---------------------------------------------------------------------------
// 画法(颜色、线宽、虚线都和平面主图 borders.ts / routes.ts / highlight.ts 一致,单位是世界单位,画的时候 × 每世界单位的屏幕像素)

export interface GlobeLineStroke {
  sets: GlobeLineSet[];
  color: string;
  /** 线宽(世界单位) */
  width: number;
  /** 虚线(世界单位) */
  dash?: number[];
  /** 柔光(世界单位;选中的大河、山脉、编年史高亮的描边) */
  blur?: number;
  /** 柔光的颜色(不给 = 和线一样) */
  glow?: string;
}

/**
 * 按顺序描边。unit = 一个世界单位是几个画布像素(平面主图同样缩放时的比例,放大以后不再变)。
 * 同一组线在一帧里只投影一次(多笔描边共用)。返回描了多少个点
 */
export function strokeGlobeLines(ctx: CanvasRenderingContext2D, P: GlobeProjector, strokes: readonly GlobeLineStroke[], unit: number): number {
  const paths = new Map<GlobeLineSet, Path2D>();
  let count = 0;
  const pathOf = (s: GlobeLineSet) => {
    let p = paths.get(s);
    if (!p) {
      p = new Path2D();
      count += traceLineSet(p, s, P, 12 + 10 * unit);
      paths.set(s, p);
    }
    return p;
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const st of strokes) {
    if (!st.sets.some((s) => s.chunks)) continue;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width * unit;
    ctx.setLineDash(st.dash ? st.dash.map((d) => d * unit) : []);
    if (st.blur) {
      ctx.shadowColor = st.glow ?? st.color;
      ctx.shadowBlur = st.blur * unit;
    } else ctx.shadowBlur = 0;
    for (const s of st.sets) if (s.chunks) ctx.stroke(pathOf(s));
  }
  ctx.restore();
  return count;
}

/**
 * 靠近球边缘的线淡一点(视线擦着球面的地方,贴图也是暗的 / 有一层大气光)。
 * 只在画完线、还没画别的东西时调用(把画布上已有的东西按离球心的距离乘一个不透明度)
 */
export function fadeRim(ctx: CanvasRenderingContext2D, P: GlobeProjector): void {
  const g = ctx.createRadialGradient(P.cx, P.cy, 0, P.cx, P.cy, P.R);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.9, 'rgba(0,0,0,1)');
  g.addColorStop(0.975, 'rgba(0,0,0,0.62)');
  g.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 国界、道路 → 线组(按年份缓存:平面主图的 borderLines / routeLines 没变,这里也不重建)

/** 手绘风国界每一笔的长度周期(一笔 + 一空,世界单位;和 borders.ts 的 inkDashes 一样) */
const INK_DASH = 5;
const INK_GAP = 3;
const INK_PENS = [1.45, 2.05, 2.75];

export interface GlobeBorderSets {
  /** 两国之间 */
  inner: GlobeLineSet;
  /** 国家和部落地带之间 */
  outer: GlobeLineSet;
  /** 手绘风:两国之间按位置分成三档粗细(每档一组) */
  pens: GlobeLineSet[] | null;
}

/**
 * 把折线按"一笔 + 一空"的周期切开,每段按起点的位置挑粗细档(inkPen),同一档连着的段接成一条线。
 * 返回每一档的折线
 */
export function splitPens(lines: readonly Polyline[], pens: number, period = INK_DASH + INK_GAP): Polyline[][] {
  const out: Polyline[][] = Array.from({ length: pens }, () => []);
  for (const l of lines) {
    const p = l.pts;
    const n = p.length >> 1;
    if (n < 2) continue;
    let cur: number[] = [p[0], p[1]];
    let pen = inkPen(p[0], p[1], pens);
    let phase = 0;
    for (let i = 1; i < n; i++) {
      const ax = p[2 * i - 2];
      const ay = p[2 * i - 1];
      const bx = p[2 * i];
      const by = p[2 * i + 1];
      const seg = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      let t = 0;
      while (seg - t > period - phase) {
        // 走到下一个周期的开头:按那里的位置重新挑一档,变了就断开
        t += period - phase;
        phase = 0;
        const x = ax + ((bx - ax) * t) / seg;
        const y = ay + ((by - ay) * t) / seg;
        const np = inkPen(x, y, pens);
        cur.push(x, y);
        if (np !== pen) {
          if (cur.length >= 4) out[pen].push({ pts: Float32Array.from(cur), closed: false });
          cur = [x, y];
          pen = np;
        }
      }
      phase += seg - t;
      cur.push(bx, by);
    }
    if (cur.length >= 4) out[pen].push({ pts: Float32Array.from(cur), closed: false });
  }
  return out;
}

const borderCache = new WeakMap<readonly SidedLine[], { fantasy: boolean; W: number; sets: GlobeBorderSets }>();

/** 国界线(borders.ts 的 borderLines,某一年某一层)→ 线组 */
export function globeBorderSets(lines: readonly SidedLine[], W: number, H: number, fantasy: boolean): GlobeBorderSets {
  const hit = borderCache.get(lines);
  if (hit && hit.fantasy === fantasy && hit.W === W) return hit.sets;
  const inner = lines.filter((l) => l.left >= 0 && l.right >= 0);
  const outer = lines.filter((l) => l.left < 0 || l.right < 0);
  const sets: GlobeBorderSets = {
    inner: buildLineSet(inner, W, H),
    outer: buildLineSet(outer, W, H),
    pens: fantasy ? splitPens(inner, INK_PENS.length).map((ls) => buildLineSet(ls, W, H)) : null,
  };
  borderCache.set(lines, { fantasy, W, sets });
  return sets;
}

export interface GlobeRouteSets {
  road: GlobeLineSet;
  trail: GlobeLineSet;
  sea: GlobeLineSet;
}

const routeCache = new WeakMap<readonly Polyline[], { W: number; sets: GlobeRouteSets }>();

/** 道路(routes.ts 的 routeLines,某一年)→ 线组 */
export function globeRouteSets(lines: { road: Polyline[]; trail: Polyline[]; sea: Polyline[] }, W: number, H: number): GlobeRouteSets {
  const hit = routeCache.get(lines.road);
  if (hit && hit.W === W) return hit.sets;
  const sets = { road: buildLineSet(lines.road, W, H), trail: buildLineSet(lines.trail, W, H), sea: buildLineSet(lines.sea, W, H) };
  routeCache.set(lines.road, { W, sets });
  return sets;
}

/** 国界的描法(和 borders.ts 的 drawBorders 一样的颜色、线宽、虚线) */
export function borderStrokes(b: GlobeBorderSets, style: CivStyle): GlobeLineStroke[] {
  if (style === 'fantasy' && b.pens) {
    return [
      // 墨线下面先垫一道淡淡的纸色
      { sets: [b.inner], color: 'rgba(246,236,210,0.6)', width: 3.8 },
      ...b.pens.map((s, i) => ({ sets: [s], color: 'rgba(58,32,20,0.9)', width: INK_PENS[i], dash: [INK_DASH, INK_GAP] })),
      // 国家和部落地带之间:点划线
      { sets: [b.outer], color: 'rgba(246,236,210,0.45)', width: 3 },
      { sets: [b.outer], color: 'rgba(58,32,20,0.78)', width: 1.35, dash: [4.2, 1.9, 0.01, 1.9] },
    ];
  }
  return [
    { sets: [b.inner, b.outer], color: 'rgba(255,252,244,0.6)', width: 4 },
    { sets: [b.inner], color: 'rgba(62,28,40,0.95)', width: 1.7 },
    { sets: [b.outer], color: 'rgba(62,28,40,0.85)', width: 1.4, dash: [3.6, 2.4] },
  ];
}

/** 道路与航线的描法(和 routes.ts 的 drawRoutes 一样) */
export function routeStrokes(r: GlobeRouteSets, style: CivStyle): GlobeLineStroke[] {
  if (style === 'fantasy') {
    return [
      { sets: [r.sea], color: 'rgba(52,58,66,0.62)', width: 1.25, dash: [0.01, 3.4] },
      { sets: [r.trail], color: 'rgba(246,236,210,0.3)', width: 2 },
      { sets: [r.road], color: 'rgba(246,236,210,0.45)', width: 2.8 },
      { sets: [r.trail], color: 'rgba(74,46,28,0.7)', width: 0.8, dash: [2.2, 2.4] },
      { sets: [r.road], color: 'rgba(74,42,24,0.9)', width: 1.2, dash: [4.6, 2.6] },
    ];
  }
  return [
    { sets: [r.sea], color: 'rgba(226,238,246,0.7)', width: 1.2, dash: [0.01, 3.2] },
    { sets: [r.trail], color: 'rgba(38,28,14,0.24)', width: 2 },
    { sets: [r.road], color: 'rgba(38,28,14,0.36)', width: 2.5 },
    { sets: [r.trail], color: 'rgba(246,230,186,0.85)', width: 0.9, dash: [2.4, 2] },
    { sets: [r.road], color: 'rgba(248,228,174,0.97)', width: 1.2 },
  ];
}
