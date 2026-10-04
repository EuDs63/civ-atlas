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

/** 在网格上做 passes 次邻居平均(近似高斯模糊)。返回新数组,不改动输入。 */
export function blurField(mesh: Mesh, f: Float32Array, passes: number) {
  const { n, adjStart, adj } = mesh;
  let a = f.slice();
  let b = new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let s = a[i];
      let c = 1;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        s += a[adj[k]];
        c++;
      }
      b[i] = s / c;
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}
