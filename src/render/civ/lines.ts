/**
 * 沿地块边界描矢量线("三角形行进法"),州界、国界共用。
 *
 * 像素归属是"三角形里重心坐标最大的顶点"(Raster.cell),所以两块地的像素分界线正好是
 * "边中点 — 三角形重心"的连线。exact = true 时就沿这些连线描,和色块严丝合缝;
 * 默认(false)在只有两组的三角形里直接连两条边的中点,少一半折角,平滑后更顺(偏差不到半个地块)。
 * 三组交汇、或一端碰到水的三角形,总是经过重心。串成折线后再用 Chaikin 抹平折角。
 *
 * 只画"陆地 — 陆地"之间的界线(标签 < 0 的地块不参与),海岸线由地形画风负责。
 *
 * 主图东西相连:边中点、三角形重心按球面算(三维平均再投回主图),
 * 每条折线的 x 展开成连续的(相邻两点不跨半张图,可能伸出主图左右边);画的时候伸出去的部分在另一边再画一份
 * (addToPath 的 wrap)。绕着极点一圈的环,展开后首尾差一整圈(x 差图宽)。
 */
import type { Mesh } from '../../gen/mesh';
import { nearX, wrapShifts } from '../common';
import { addProjectedLine, type Projector } from '../projection';

/** 一条折线:世界坐标 x,y,x,y…;closed = 首尾相连成环 */
export interface Polyline {
  pts: Float32Array;
  closed: boolean;
}

/** 世界东西相连的周期(= 世界宽度) */
export function meshWrap(mesh: Mesh): number {
  return mesh.width;
}

/**
 * 球面网格上几个地块中心的"平均位置"(单位向量相加再投回主图),写进 out = [x, y];
 * 两个地块 = 边中点,三个 = 三角形重心。c < 0 表示只有两个
 */
export function sphereMean(mesh: Mesh, a: number, b: number, c: number, out: number[]): void {
  const p = mesh.xyz;
  let sx = p[3 * a] + p[3 * b];
  let sy = p[3 * a + 1] + p[3 * b + 1];
  let sz = p[3 * a + 2] + p[3 * b + 2];
  if (c >= 0) {
    sx += p[3 * c];
    sy += p[3 * c + 1];
    sz += p[3 * c + 2];
  }
  const l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
  let x = ((Math.atan2(sy, sx) + Math.PI) / (2 * Math.PI)) * mesh.width;
  if (x >= mesh.width) x -= mesh.width;
  out[0] = x;
  out[1] = ((Math.PI / 2 - Math.asin(Math.max(-1, Math.min(1, sz / l)))) / Math.PI) * mesh.height;
}

/** 折线(x, y 交错)的 x 原地展开成连续的:每一点挪到离上一点最近的那一份(W = 0 不动) */
export function unwrapLine(pts: number[] | Float32Array, W: number): void {
  if (!W) return;
  for (let i = 2; i < pts.length; i += 2) pts[i] = nearX(pts[i], pts[i - 2], W);
}

/**
 * label[地块] → 分组编号(< 0 = 不参与,比如水)。返回所有分组之间的分界折线(世界坐标,未平滑)。
 */
export function traceBoundaries(mesh: Mesh, label: ArrayLike<number>, exact = false): Polyline[] {
  const { n, triangles } = mesh;
  const nodeOf = new Map<number, number>();
  const nx: number[] = [];
  const ny: number[] = [];
  const links: number[][] = [];
  const node = (key: number, px: number, py: number) => {
    let id = nodeOf.get(key);
    if (id === undefined) {
      id = nx.length;
      nodeOf.set(key, id);
      nx.push(px);
      ny.push(py);
      links.push([]);
    }
    return id;
  };
  const link = (a: number, b: number) => {
    links[a].push(b);
    links[b].push(a);
  };
  const W = meshWrap(mesh);
  const tmp = [0, 0];
  const mid = (a: number, b: number) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    sphereMean(mesh, a, b, -1, tmp);
    return node(lo * n + hi, tmp[0], tmp[1]);
  };
  const edgeKeys = n * n;

  const v = [0, 0, 0];
  const l = [0, 0, 0];
  const diff: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    v[0] = triangles[t];
    v[1] = triangles[t + 1];
    v[2] = triangles[t + 2];
    l[0] = label[v[0]];
    l[1] = label[v[1]];
    l[2] = label[v[2]];
    // 边 e 是 (v[e], v[(e+1)%3]);两端都参与且分组不同 → 界线穿过它的中点
    diff.length = 0;
    for (let e = 0; e < 3; e++) {
      const la = l[e];
      const lb = l[(e + 1) % 3];
      if (la >= 0 && lb >= 0 && la !== lb) diff.push(e);
    }
    if (!diff.length) continue;
    if (!exact && diff.length === 2) {
      link(mid(v[diff[0]], v[(diff[0] + 1) % 3]), mid(v[diff[1]], v[(diff[1] + 1) % 3]));
      continue;
    }
    sphereMean(mesh, v[0], v[1], v[2], tmp);
    const c = node(edgeKeys + t, tmp[0], tmp[1]);
    for (const e of diff) link(mid(v[e], v[(e + 1) % 3]), c);
  }

  // 串线:先从端点 / 交汇点(度数 ≠ 2)出发,再处理剩下的环
  const used = new Set<number>();
  const ekey = (a: number, b: number) => (a < b ? a * nx.length + b : b * nx.length + a);
  const out: Polyline[] = [];
  const walk = (start: number, next: number) => {
    const pts = [nx[start], ny[start]];
    let prev = start;
    let cur = next;
    used.add(ekey(prev, cur));
    for (;;) {
      pts.push(nx[cur], ny[cur]);
      if (cur === start) {
        unwrapLine(pts, W);
        return { pts: Float32Array.from(pts), closed: true };
      }
      if (links[cur].length !== 2) break;
      const nxt = links[cur][0] === prev ? links[cur][1] : links[cur][0];
      const k = ekey(cur, nxt);
      if (used.has(k)) break;
      used.add(k);
      prev = cur;
      cur = nxt;
    }
    unwrapLine(pts, W);
    return { pts: Float32Array.from(pts), closed: false };
  };
  for (let a = 0; a < nx.length; a++) {
    if (links[a].length === 2) continue;
    for (const b of links[a]) if (!used.has(ekey(a, b))) out.push(walk(a, b));
  }
  for (let a = 0; a < nx.length; a++) {
    for (const b of links[a]) if (!used.has(ekey(a, b))) out.push(walk(a, b));
  }
  return out;
}

/**
 * Chaikin 平滑:每轮把每段切成 1/4、3/4 两点。开放折线保留端点(交汇处不断开)。
 * 环的最后一点等于第一点(绕极点一圈的环,展开后最后一点 = 第一点挪一整圈),平滑后照样首尾对上
 */
export function chaikin(line: Polyline, rounds = 2): Polyline {
  let p = line.pts;
  for (let r = 0; r < rounds; r++) {
    const m = p.length / 2;
    if (m < 3) break;
    const out: number[] = [];
    if (!line.closed) out.push(p[0], p[1]);
    // 环的最后一点等于第一点,所以两种情况都是 m - 1 段
    for (let i = 0; i < m - 1; i++) {
      const ax = p[i * 2];
      const ay = p[i * 2 + 1];
      const bx = p[i * 2 + 2];
      const by = p[i * 2 + 3];
      out.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
    }
    if (!line.closed) out.push(p[p.length - 2], p[p.length - 1]);
    else {
      const wx = p[p.length - 2] - p[0];
      out.push(wx ? out[0] + wx : out[0], out[1]);
    }
    p = Float32Array.from(out);
  }
  return { pts: p, closed: line.closed };
}

/** 折线的横坐标范围(世界单位) */
export function xRange(p: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < lo) lo = p[i];
    if (p[i] > hi) hi = p[i];
  }
  return [lo, hi];
}

/**
 * 把折线加进一条 Path2D(按 scale 换算成像素)。
 * wrap = 世界东西相连时的周期(世界宽度,见 meshWrap):伸出主图左右边的线在另一边再加一份。
 * proj(弯边投影,按投影重画):逐点投影到地图平面再 × scale,长段加密;伸出 ±180° 的在另一边再加一份
 * (落在外轮廓外的那截由调用方按外轮廓裁掉)
 */
export function addToPath(path: Path2D, lines: Polyline[], scale: number, wrap: number, proj?: Projector | null) {
  if (proj) {
    const v = { s: scale, ox: 0, oy: 0 };
    for (const l of lines) addProjectedLine(path, l.pts, 2, proj, v, false);
    return;
  }
  for (const l of lines) {
    const p = l.pts;
    const [lo, hi] = xRange(p);
    for (const sh of wrapShifts(lo, hi, wrap, 4)) {
      path.moveTo((p[0] + sh) * scale, p[1] * scale);
      for (let i = 2; i < p.length; i += 2) path.lineTo((p[i] + sh) * scale, p[i + 1] * scale);
    }
  }
}
