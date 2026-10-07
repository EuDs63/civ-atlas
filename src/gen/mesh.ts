/**
 * 不规则网格:球面泊松圆盘撒点 + 球面 Delaunay 三角剖分。
 *
 * 世界不是像素格,而是几万个大小相近、形状不规则的"地块"(每个点 = 一个地块的中心)。
 * 好处:没有格子感,河流/海岸不会沿横竖方向走;模拟只算几万个点,比百万像素快得多。
 * 世界是一整颗星球(东西无缝、有南北极):地块撒在单位球面上,
 * 地块之间多远、怎么撒点这类"世界是什么形状"的计算在 geometry.ts;这里只有网格的数据结构和纯邻接的操作。
 */
import type { Rng } from './util';
import { buildSphereMesh } from './geometry';

export interface Mesh {
  width: number;
  height: number;
  spacing: number;
  n: number;
  /**
   * 地块中心的世界坐标:等距圆柱主图上的位置(x ∈ [0, width) ↔ 经度 −180°…180°,y ∈ [0, height] ↔ 纬度 90°…−90°)
   */
  x: Float32Array;
  y: Float32Array;
  /** 邻接表(CSR):cell i 的邻居是 adj[adjStart[i] .. adjStart[i+1]) */
  adjStart: Int32Array;
  adj: Int32Array;
  /**
   * Delaunay 三角形顶点索引,栅格化用。三角形铺满整颗球(个数 = 2n − 4);
   * 跨 180° 经线、包着极点的三角形(在主图上横跨半张图以上)排在最前面
   */
  triangles: Uint32Array;
  /** 每个地块在单位球面上的位置,交错存 x, y, z(z 轴 = 地轴,北极 z = 1) */
  xyz: Float32Array;
}

/**
 * 建网格:球面泊松圆盘撒点 + 剖分(算法在 geometry.ts 的 buildSphereMesh:撒点时的"两点多远"是几何的一部分)。
 * width = 赤道一圈的长度(世界单位),spacing 按世界单位
 */
export function buildMesh(width: number, height: number, spacing: number, rng: Rng): Mesh {
  return buildSphereMesh(width, height, spacing, rng);
}

/**
 * 在网格上做 passes 次邻居平均(近似高斯模糊)。返回新数组,不改动输入。
 *
 * 每个地块 = (自己 + 邻居们)按邻接表的先后逐个加起来,再除以个数。两处只为快、结果逐位不变:
 *   - 地块按邻居个数分组算(见 degreeGroups),同一组里循环次数固定
 *   - 遍数多时(SPARSE_PASSES 起)只算会变的地块:一个地块和它的邻居全都同值(32 位逐位相同)时,
 *     平均下来还是这个值(同一个 32 位数连加几次在 64 位里没有舍入,再除以个数正好得回它自己),
 *     所以第 p 遍(从 0 数)只可能改动"离不全同值的地方不超过 p 步"的地块,其余的保持原值。
 *     大片同值的场(海里全是 0、板块内部全是 1)快很多
 */
export function blurField(mesh: Mesh, f: Float32Array, passes: number) {
  const { n, adjStart, adj } = mesh;
  let a = f.slice();
  if (passes <= 0) return a;
  const front = passes >= SPARSE_PASSES ? blurFront(mesh, a, passes) : null;
  const cells = front ? front.cells : degreeGroups(mesh);
  let b = front ? a.slice() : new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    for (let g = 0; g < DEGREES.length; g++) blurRun(adjStart, adj, a, b, cells[g], front ? front.ends[g][p] : cells[g].length, DEGREES[g]);
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

/** 遍数到这么多才只算会变的地块(找这些地块要先把全部地块扫一遍,遍数少时不划算) */
const SPARSE_PASSES = 8;
/** 地块按邻居个数分的组:6、5、7 个邻居的各一组(球面网格上占九成以上),其余的一组(0 = 个数不定) */
const DEGREES = [6, 5, 7, 0];
const groupOf = (d: number) => (d === 6 ? 0 : d === 5 ? 1 : d === 7 ? 2 : 3);

const groupCache = new WeakMap<Mesh, Int32Array[]>();
/** 全部地块按邻居个数分组(组内按编号),按网格缓存 */
function degreeGroups(mesh: Mesh): Int32Array[] {
  let g = groupCache.get(mesh);
  if (g) return g;
  const { n, adjStart } = mesh;
  const cnt = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) cnt[groupOf(adjStart[i + 1] - adjStart[i])]++;
  g = cnt.map((c) => new Int32Array(c));
  cnt.fill(0);
  for (let i = 0; i < n; i++) {
    const q = groupOf(adjStart[i + 1] - adjStart[i]);
    g[q][cnt[q]++] = i;
  }
  groupCache.set(mesh, g);
  return g;
}

/**
 * 每一遍会变的地块(见 blurField):从"自己和邻居不全同值"的地块(按位比:+0 和 −0 算不同,NaN 一律算不同)一步一步往外扩。
 * 返回按邻居个数分好组的地块(每组按先近后远、同一步里按编号排)和 ends[组][p] = 第 p 遍算这一组的前几个;
 * 一开始就有一半以上的地块要算时返回 null(照常每遍算全部)
 */
function blurFront(mesh: Mesh, a: Float32Array, passes: number): { cells: Int32Array[]; ends: Int32Array[] } | null {
  const { n, adjStart, adj } = mesh;
  const bits = new Int32Array(a.buffer, a.byteOffset, n);
  const seen = new Uint8Array(n);
  const list = new Int32Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    const v = bits[i];
    let same = a[i] === a[i];
    for (let k = adjStart[i]; same && k < adjStart[i + 1]; k++) same = bits[adj[k]] === v;
    if (!same) {
      seen[i] = 1;
      list[len++] = i;
    }
  }
  if (len > n >> 1) return null;
  const cells = DEGREES.map(() => new Int32Array(n));
  const ends = DEGREES.map(() => new Int32Array(passes));
  const cnt = [0, 0, 0, 0];
  let from = 0;
  for (let p = 0; p < passes; p++) {
    if (p > 0) {
      // 再往外一步:上一层的邻居里还没算进来的
      const to = len;
      for (let q = from; q < to; q++) {
        const i = list[q];
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const j = adj[k];
          if (!seen[j]) {
            seen[j] = 1;
            list[len++] = j;
          }
        }
      }
      from = to;
      list.subarray(from, len).sort();
    }
    for (let q = from; q < len; q++) {
      const i = list[q];
      const g = groupOf(adjStart[i + 1] - adjStart[i]);
      cells[g][cnt[g]++] = i;
    }
    for (let g = 0; g < DEGREES.length; g++) ends[g][p] = cnt[g];
  }
  return { cells, ends };
}

/** 一遍邻居平均,只算 cells 的前 m 个地块(都有 deg 个邻居;0 = 个数不定)。加法的先后和逐个累加一样 */
function blurRun(adjStart: Int32Array, adj: Int32Array, a: Float32Array, b: Float32Array, cells: Int32Array, m: number, deg: number) {
  if (deg === 6) {
    for (let q = 0; q < m; q++) {
      const i = cells[q];
      const k = adjStart[i];
      b[i] = (a[i] + a[adj[k]] + a[adj[k + 1]] + a[adj[k + 2]] + a[adj[k + 3]] + a[adj[k + 4]] + a[adj[k + 5]]) / 7;
    }
  } else if (deg === 5) {
    for (let q = 0; q < m; q++) {
      const i = cells[q];
      const k = adjStart[i];
      b[i] = (a[i] + a[adj[k]] + a[adj[k + 1]] + a[adj[k + 2]] + a[adj[k + 3]] + a[adj[k + 4]]) / 6;
    }
  } else if (deg === 7) {
    for (let q = 0; q < m; q++) {
      const i = cells[q];
      const k = adjStart[i];
      b[i] = (a[i] + a[adj[k]] + a[adj[k + 1]] + a[adj[k + 2]] + a[adj[k + 3]] + a[adj[k + 4]] + a[adj[k + 5]] + a[adj[k + 6]]) / 8;
    }
  } else {
    for (let q = 0; q < m; q++) {
      const i = cells[q];
      let s = a[i];
      let c = 1;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        s += a[adj[k]];
        c++;
      }
      b[i] = s / c;
    }
  }
}
