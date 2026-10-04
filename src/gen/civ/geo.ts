/**
 * 文明算法里"两块地多远 / 多大"的常用量和几个基准。
 *
 * 文明算法只沿 mesh 邻接关系走,距离、面积都来自几何层(gen/geometry.ts)。
 * 面积、间距类常数的基准(refCellArea / refSpacing)按主图的比例尺定:赤道一圈 = 地图宽(1 单位约 20 公里),
 * 同样大的山、同样远的路按真实大小算。
 */
import type { Mesh } from '../mesh';
import { geometryOf } from '../geometry';

/** 一个世界单位约多少公里(赤道处;地图宽 2048 单位 ≈ 地球周长 4 万公里) */
export const KM_PER_UNIT = 40000 / 2048;

/** 默认精细度(地块数参数)。面积、间距类常数都以它为基准,换精细度时结果大致不变 */
export const REF_CELLS = 36000;

/**
 * 基准地块的面积(世界单位²):主图(宽 × 高)按默认精细度分的一块地的面积,约 2.2 万平方公里。
 * 真实的地块比它细约两成(默认 3.6 万块铺满整颗球,球面积只有主图的 64%),但地名的门槛、民族 / 国家走一步的
 * "标准路程"、翻山的代价这些按它算(以前的平面地图就是这个大小,各处的参数都按它调过)
 */
export function refCellArea(mesh: Mesh): number {
  return (mesh.width * mesh.height) / REF_CELLS;
}

/** 基准地块的间距(世界单位,约等于主图按默认精细度分时相邻地块的平均间距) */
export function refSpacing(mesh: Mesh): number {
  return Math.sqrt(refCellArea(mesh)) * 1.02;
}

/**
 * 默认精细度下网格的实际地块数(略少于参数值;州数按精细度修正时的基准,见 regions.ts):
 * 泊松撒点铺满整颗球,约 0.944 倍
 */
export const REF_MESH_CELLS = REF_CELLS * 0.944;

/**
 * 州的目标面积乘这个数。球面的总面积只有主图的 64%(高纬度在主图上被"东西向拉宽"),可居的陆地相应少一些;
 * 州按同样的面积划的话州数偏少,民族数、国都间距这些"按可居州数定"的量跟着少一截。
 * 目标面积缩一点,默认参数下约 900 个州
 */
export const REGION_AREA_SCALE = 0.85;

/** 两个地块中心的距离(世界单位) */
export function edgeLen(mesh: Mesh, i: number, j: number): number {
  return geometryOf(mesh).dist(i, j);
}

/** 每条邻接边的长度,和 mesh.adj 一一对应(洇染时查表,省得反复开方) */
export function adjLengths(mesh: Mesh): Float32Array {
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);
  const out = new Float32Array(adj.length);
  for (let i = 0; i < n; i++) {
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) out[k] = geo.dist(i, adj[k]);
  }
  return out;
}

/**
 * 每个地块的面积(世界单位²):每个 Delaunay 三角形的面积三等分给三个顶点。
 * 总和等于整颗球的面积,和 Voronoi 面积很接近,又不用建 Voronoi 图。
 */
export function cellAreas(mesh: Mesh): Float32Array {
  return geometryOf(mesh).cellAreas();
}
