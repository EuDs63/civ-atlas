/**
 * 几何层(gen/geometry.ts)的基本性质:
 * 距离对称、到自己为 0、三角不等式;最近地块和逐个比出来的一样;局部平面来回换算不走样;纬度在范围内;面积加起来是整个表面;
 * 整颗球、没有边;东西相连;沿大圆走;风带切口;欧拉轴板块;改地形的笔画;文明层用的方位、局部平面、标注路径。
 */
import { describe, expect, it } from 'vitest';
import { buildMesh } from '../src/gen/mesh';
import { geometryOf, sphereRadius, sphereSpacing } from '../src/gen/geometry';
import { MAP_H, MAP_W } from '../src/gen/world';
import { mulberry32, subSeed } from '../src/gen/util';

const sphere = buildMesh(MAP_W, MAP_H, sphereSpacing(MAP_W, 6000), mulberry32(subSeed(3, 'mesh')));
const R = sphereRadius(MAP_W);

describe('几何层:基本性质', () => {
  const mesh = sphere;
  const geo = geometryOf(mesh);
  const rng = mulberry32(99);
  const pick = () => Math.floor(rng() * mesh.n);

  it('按网格缓存:同一个网格拿到同一个对象;表面积', () => {
    expect(geometryOf(mesh)).toBe(geo);
    expect(geo.kind).toBe('sphere');
    expect(geo.area).toBeCloseTo(4 * Math.PI * R * R, 6);
  });

  it('距离:对称、到自己为 0、和平方一致、满足三角不等式', () => {
    for (let t = 0; t < 500; t++) {
      const a = pick();
      const b = pick();
      const c = pick();
      expect(geo.dist(a, b)).toBe(geo.dist(b, a));
      expect(geo.dist(a, a)).toBe(0);
      expect(geo.dist(a, b) ** 2).toBeCloseTo(geo.dist2(a, b), 6);
      expect(geo.dist(a, c)).toBeLessThanOrEqual(geo.dist(a, b) + geo.dist(b, c) + 1e-9);
      // 世界坐标换回单位向量有舍入(24 位),差不到千分之一个世界单位
      expect(geo.distTo(a, mesh.x[b], mesh.y[b])).toBeCloseTo(geo.dist(a, b), 3);
      expect(geo.dist(a, b)).toBeLessThanOrEqual(2 * R + 1e-6);
    }
  });

  it('最近地块:和逐个比出来的一样;连续查也一样', () => {
    const find = geo.locator();
    for (let t = 0; t < 300; t++) {
      const px = rng() * MAP_W;
      const py = rng() * MAP_H;
      let best = 0;
      for (let i = 1; i < mesh.n; i++) if (geo.distTo(i, px, py) < geo.distTo(best, px, py)) best = i;
      expect(geo.distTo(geo.nearest(px, py, pick()), px, py)).toBe(geo.distTo(best, px, py));
      expect(geo.distTo(find(px, py), px, py)).toBe(geo.distTo(best, px, py));
    }
  });

  it('局部平面:地块坐标换回世界坐标就是地块本身;局部坐标里的距离 ≈ 真实距离', () => {
    for (let t = 0; t < 100; t++) {
      const c = pick();
      const center = mesh.adj[mesh.adjStart[c]];
      const ch = geo.chart(center);
      // 方位等距投影,来回换算的误差只在舍入量级;中心附近局部坐标的长度就是(大圆)距离
      const x = ch.toX(ch.u(c), ch.v(c));
      const y = ch.toY(ch.u(c), ch.v(c));
      expect(geo.distTo(c, x, y)).toBeLessThan(1e-3);
      expect(ch.toU(mesh.x[c], mesh.y[c])).toBeCloseTo(ch.u(c), 2);
      expect(ch.toV(mesh.x[c], mesh.y[c])).toBeCloseTo(ch.v(c), 2);
      // 方位等距:到中心的局部距离 = 大圆距离(弦长 d 对应的弧长 2R·asin(d / 2R))
      expect(Math.hypot(ch.u(c), ch.v(c))).toBeCloseTo(2 * R * Math.asin(geo.dist(c, center) / (2 * R)), 3);
    }
  });

  it('方向:从 i 指向 j 的单位方向点乘自己的反向 ≈ −1;挪过去再找最近 = 原地块附近', () => {
    const out = [0, 0];
    for (let t = 0; t < 200; t++) {
      const i = pick();
      const k = mesh.adj[mesh.adjStart[i]];
      geo.offset(i, k, out);
      const l = Math.hypot(out[0], out[1]);
      // 弦的方向和大圆在 i 处的切向差半个圆心角(邻居之间约百分之一到百分之四弧度)
      expect(geo.edgeDot(i, k, out[0] / l, out[1] / l)).toBeCloseTo(1, 2);
      // 反过来在 k 处用同一组(东, 南)分量:相邻两块的东、南方向不完全一样(经线向极点收拢),高纬度差得多一些
      expect(geo.edgeDot(k, i, out[0] / l, out[1] / l)).toBeLessThan(Math.abs(geo.latitude(i)) < 60 ? -0.95 : -0.3);
      geo.moveCell(out, i, 0.1, -0.1);
      expect(geo.distTo(geo.nearest(out[0], out[1], i), out[0], out[1])).toBeLessThanOrEqual(geo.distTo(i, out[0], out[1]));
    }
  });

  it('纬度在 ±90° 以内、两极都有地块;面积加起来等于整个表面', () => {
    let top = -90;
    let bottom = 90;
    for (let i = 0; i < mesh.n; i++) {
      const v = geo.latitude(i);
      expect(v).toBeLessThanOrEqual(90);
      expect(v).toBeGreaterThanOrEqual(-90);
      top = Math.max(top, v);
      bottom = Math.min(bottom, v);
    }
    // 有真正的两极:离两个极点最近的地块都在 88° 以外
    expect(top).toBeGreaterThan(88);
    expect(bottom).toBeLessThan(-88);
    const area = geo.cellAreas().reduce((s, a) => s + a, 0);
    expect(area / geo.area).toBeCloseTo(1, 3);
  });
});

describe('几何层:整颗球、没有边', () => {
  const geo = geometryOf(sphere);
  it('三角形铺满整颗球(2n − 4 个),邻接对称,三角形的边都是邻接边', () => {
    const { n, adjStart, adj, triangles } = sphere;
    expect(triangles.length / 3).toBe(2 * n - 4);
    const has = (a: number, b: number) => {
      for (let k = adjStart[a]; k < adjStart[a + 1]; k++) if (adj[k] === b) return true;
      return false;
    };
    for (let i = 0; i < n; i++) for (let k = adjStart[i]; k < adjStart[i + 1]; k++) expect(has(adj[k], i)).toBe(true);
    for (let t = 0; t < triangles.length; t += 3) {
      expect(has(triangles[t], triangles[t + 1])).toBe(true);
      expect(has(triangles[t + 1], triangles[t + 2])).toBe(true);
      expect(has(triangles[t + 2], triangles[t])).toBe(true);
    }
  });

  it('地块在单位球面上,世界坐标就是它的经纬度', () => {
    const p = sphere.xyz;
    for (let i = 0; i < sphere.n; i++) {
      expect(Math.hypot(p[3 * i], p[3 * i + 1], p[3 * i + 2])).toBeCloseTo(1, 6);
      expect(sphere.x[i]).toBeGreaterThanOrEqual(0);
      expect(sphere.x[i]).toBeLessThan(MAP_W);
      const lon = (sphere.x[i] / MAP_W) * 2 * Math.PI - Math.PI;
      const lat = Math.PI / 2 - (sphere.y[i] / MAP_H) * Math.PI;
      expect(Math.cos(lat) * Math.cos(lon)).toBeCloseTo(p[3 * i], 5);
      expect(Math.cos(lat) * Math.sin(lon)).toBeCloseTo(p[3 * i + 1], 5);
      expect(Math.sin(lat)).toBeCloseTo(p[3 * i + 2], 5);
    }
  });

  it('东西相连:180° 经线两边的点离得很近;北极点的任何经度都是同一个点', () => {
    expect(geo.pointDist(0.5, 512, MAP_W - 0.5, 512)).toBeCloseTo(1, 3);
    expect(geo.pointDist(0, 300, MAP_W, 300)).toBeLessThan(1e-3);
    expect(geo.pointDist(100, 0, 1500, 0)).toBeLessThan(1e-3);
    // 世界坐标 x 超出 [0, 宽) 也按经度解释(改地形跨接缝的笔画)
    expect(geo.pointDist(-10, 400, MAP_W - 10, 400)).toBeLessThan(1e-3);
    expect(geo.pointDist(MAP_W + 25, 400, 25, 400)).toBeLessThan(1e-3);
  });

  it('沿大圆走:走出去再算距离 = 走的长度;往东走一圈回到原处', () => {
    const out = [0, 0];
    const rng = mulberry32(5);
    for (let t = 0; t < 100; t++) {
      const i = Math.floor(rng() * sphere.n);
      const L = 5 + 300 * rng();
      const a = rng() * Math.PI * 2;
      geo.moveCell(out, i, L * Math.cos(a), L * Math.sin(a));
      // 弦长 = 2R sin(θ/2),θ = L / R
      expect(geo.distTo(i, out[0], out[1])).toBeCloseTo(2 * R * Math.sin(L / R / 2), 2);
    }
    // 赤道附近的地块往东走一整圈(2πR)回到原处
    let eq = 0;
    for (let i = 0; i < sphere.n; i++) if (Math.abs(sphere.y[i] - 512) < Math.abs(sphere.y[eq] - 512)) eq = i;
    geo.moveCell(out, eq, 2 * Math.PI * R, 0);
    expect(geo.distTo(eq, out[0], out[1])).toBeLessThan(1e-2);
  });

  it('风带切口:每条风带一条,落在陆地最少的地方;顺风排序在切口两边断开', () => {
    // 造一块只在 x ∈ [0, 1024) 的"半球大陆"
    const water = new Uint8Array(sphere.n);
    for (let i = 0; i < sphere.n; i++) water[i] = sphere.x[i] < 1024 ? 0 : 1;
    const cuts = geo.windCuts(water)!;
    expect(cuts.length).toBe(6);
    for (const c of cuts) {
      expect(c).toBeGreaterThan(1024);
      expect(c).toBeLessThan(MAP_W);
    }
    // 信风(吹向西):切口西边一点的地块排在最前(最上风),切口东边一点的排在最后
    let west = -1;
    let east = -1;
    for (let i = 0; i < sphere.n; i++) {
      if (Math.abs(sphere.y[i] - 600) > 20) continue;
      const dx = sphere.x[i] - cuts[3];
      if (dx < 0 && dx > -30 && west < 0) west = i;
      if (dx > 0 && dx < 30 && east < 0) east = i;
    }
    expect(geo.downwind(west, -1, 0, cuts)).toBeLessThan(geo.downwind(east, -1, 0, cuts));
  });

  it('板块绕欧拉轴转动:质心处的速度就是给定的速度,速度处处和球面相切', () => {
    const plate = new Int16Array(sphere.n);
    const area = new Float32Array(2);
    for (let i = 0; i < sphere.n; i++) {
      plate[i] = sphere.x[i] < 1024 ? 0 : 1;
      area[plate[i]]++;
    }
    const cen = geo.groupCentroids(plate, 2, area);
    const vx = Float32Array.of(0.6, -0.3);
    const vy = Float32Array.of(0.2, 0.5);
    const m = geo.plateMotion(vx, vy, cen.x, cen.y, [0.5, -0.8]);
    const c0 = geo.nearest(cen.x[0], cen.y[0], 0);
    const v = [0, 0];
    m.at(0, c0, v);
    // 质心附近的地块:速度接近给定值
    expect(v[0]).toBeCloseTo(0.6, 1);
    expect(v[1]).toBeCloseTo(0.2, 1);
    // |ω × p| ≤ |ω|
    const om = m.omega;
    const wl = Math.hypot(om[0], om[1], om[2]);
    for (let i = 0; i < sphere.n; i += 37) {
      m.at(0, i, v);
      expect(Math.hypot(v[0], v[1])).toBeLessThanOrEqual(wl + 1e-6);
    }
  });

  it('改地形的笔画按经纬度:沿纬线的一笔,离它的距离在各处一样;跨 180° 经线走短的那边;x 超出地图照样对', () => {
    const line = geo.polyline([100, 400, 700, 400], 50);
    for (const x of [150, 300, 450, 650]) expect(line.nearest(x, 420).d).toBeCloseTo(20, 0);
    // 从 x = 2000 画到 x = 40:走跨 180° 经线的那 88 个单位,不是横穿整张图
    const seam = geo.polyline([2000, 512, 40, 512], 10);
    expect(seam.len).toBeCloseTo(88, 0);
    expect(seam.nearest(1024, 512).d).toBeGreaterThan(500);
    // 同一笔,点按上一个点展开写(x 超出地图宽):和取模写的是同一条线
    const open = geo.polyline([2000, 512, 2088, 512], 10);
    expect(open.len).toBeCloseTo(88, 0);
    for (const x of [2010, 2040, 0, 30]) expect(open.nearest(x, 520).d).toBeCloseTo(seam.nearest(x, 520).d, 3);
  });

  // ---- 文明层用的(迁徙 / 复国 / 迁都的方位,地名的局部平面、标注路径、大洋方位) ----

  /** 经纬度(度)→ 世界坐标 */
  const X = (lon: number) => ((lon + 180) / 360) * MAP_W;
  const Y = (lat: number) => ((90 - lat) / 180) * MAP_H;

  it('当地方位跨 180° 经线按短的一边:往东跨过去是东;越过北极的先往北', () => {
    const d = [0, 0];
    geo.pointOffset(X(175), Y(10), X(-175), Y(10), d);
    expect(d[0]).toBeGreaterThan(50);
    expect(Math.abs(d[1])).toBeLessThan(0.1 * d[0]);
    geo.pointOffset(X(-175), Y(10), X(175), Y(10), d);
    expect(d[0]).toBeLessThan(-50);
    // 经度 0°、北纬 80° → 经度 180°、北纬 80°:大圆过北极,出发时正北(南向分量为负),路程 = 20° 的弧
    geo.pointOffset(X(0), Y(80), X(180), Y(80), d);
    expect(d[1]).toBeCloseTo(-(20 / 180) * Math.PI * R, 1);
    expect(Math.abs(d[0])).toBeLessThan(0.5);
    // 地块之间(offset)同理:180° 经线两侧的一对地块
    let a = -1;
    let b = -1;
    for (let i = 0; i < sphere.n; i++) {
      if (Math.abs(sphere.y[i] - Y(0)) > 40) continue;
      if (sphere.x[i] > MAP_W - 30 && (a < 0 || sphere.x[i] > sphere.x[a])) a = i;
      if (sphere.x[i] < 30 && (b < 0 || sphere.x[i] < sphere.x[b])) b = i;
    }
    geo.offset(a, b, d);
    expect(d[0]).toBeGreaterThan(0);
    expect(Math.hypot(d[0], d[1])).toBeLessThan(80);
  });

  it('一片地块的局部平面切在质心附近:跨 180° 经线的一片,切点在两边中间;换回世界坐标连成一片', () => {
    const cells: number[] = [];
    for (let i = 0; i < sphere.n; i++) if (Math.abs(sphere.y[i] - Y(20)) < 40 && (sphere.x[i] > MAP_W - 60 || sphere.x[i] < 60)) cells.push(i);
    expect(cells.length).toBeGreaterThan(10);
    // cells[0] 是编号最小的,不一定在中间;加权质心在 180° 经线上
    const ch = geo.chartOf(cells, () => 1);
    const cx = ch.toX(0, 0);
    const cy = ch.toY(0, 0);
    expect(geo.pointDist(cx, cy, 0, Y(20))).toBeLessThan(2 * sphere.spacing);
    for (const c of cells) {
      const x = ch.toX(ch.u(c), ch.v(c));
      expect(Math.abs(x - cx)).toBeLessThan(80);
      expect(geo.distTo(c, x, ch.toY(ch.u(c), ch.v(c)))).toBeLessThan(1e-3);
    }
    // 权重全为 0:退回第一块
    const z = geo.chartOf(cells, () => 0);
    expect(geo.distTo(cells[0], z.toX(0, 0), z.toY(0, 0))).toBeLessThan(1e-3);
  });

  it('主图局部平面:过原点的纬线 / 经线在主图上横平竖直;u 是沿纬线的真实长度;跨 180° 经线不取模', () => {
    const lat = 40;
    const mc = geo.mapChart(X(177), Y(lat));
    expect(mc.toU(X(177), Y(lat))).toBe(0);
    expect(mc.toV(X(177), Y(lat))).toBe(0);
    for (const u of [-120, -30, 40, 150]) expect(mc.toY(u, 0)).toBe(Y(lat));
    for (const v of [-80, 60]) expect(mc.toX(0, v)).toBe(X(177));
    // 往东 100 个世界单位:经度差 = 100 / (R·cos 纬度),落在 180° 经线另一侧,x 不取模(超出地图宽)
    const x = mc.toX(100, 0);
    expect(x).toBeGreaterThan(MAP_W);
    expect(((x - X(177)) / MAP_W) * 2 * Math.PI * R * Math.cos((lat * Math.PI) / 180)).toBeCloseTo(100, 1);
    // 取模以后的同一个点换回来还是 u = 100
    expect(mc.toU(x - MAP_W, Y(lat))).toBeCloseTo(100, 3);
    // 竖直方向:v 就是沿经线的长度,夹在主图里
    expect(mc.toV(X(177), Y(lat - 10))).toBeCloseTo((10 / 180) * Math.PI * R, 3);
    expect(mc.toY(0, -1e4)).toBe(0);
    // 短距离上 u 和大圆距离一致
    expect(geo.pointDist(X(177), Y(lat), mc.toX(20, 0), Y(lat))).toBeCloseTo(20, 1);
  });

  it('标注路径:跨 180° 经线的一笔整条挪整数个地图宽,让按长度的中点落在地图里', () => {
    const p = new Float32Array([2000, 100, 2060, 100, 2120, 100]);
    geo.centerPath(p);
    expect(Array.from(p)).toEqual([2000 - MAP_W, 100, 2060 - MAP_W, 100, 2120 - MAP_W, 100]);
    const q = new Float32Array([-90, 10, 20, 10]);
    geo.centerPath(q);
    expect(Array.from(q)).toEqual([-90 + MAP_W, 10, 20 + MAP_W, 10]);
    // 中点已在图里的不动;一个点的也照样
    const r = new Float32Array([-10, 5, 90, 5]);
    geo.centerPath(r);
    expect(Array.from(r)).toEqual([-10, 5, 90, 5]);
    const one = new Float32Array([2050, 7]);
    geo.centerPath(one);
    expect(Array.from(one)).toEqual([2, 7]);
  });

  it('大洋方位按主图位置:东边叫东、西边叫西、高纬度叫北 / 南、居中不叫;180° 经线两侧 30° 以内不叫东西', () => {
    const at = (lon: number, lat: number) => geo.nearest(X(lon), Y(lat), 0);
    expect(geo.mapSide(at(0, 0))).toBeNull();
    expect(geo.mapSide(at(60, -20))).toBeNull();
    expect(geo.mapSide(at(130, 0))).toBe('e');
    expect(geo.mapSide(at(-130, 5))).toBe('w');
    expect(geo.mapSide(at(20, 55))).toBe('n');
    expect(geo.mapSide(at(-20, -55))).toBe('s');
    // 主图最东边、最西边(180° 经线附近):不叫东西;高纬度照样叫南北
    expect(geo.mapSide(at(170, 0))).toBeNull();
    expect(geo.mapSide(at(-172, 10))).toBeNull();
    expect(geo.mapSide(at(175, -60))).toBe('s');
    expect(geo.mapSide(at(-175, 62))).toBe('n');
  });
});
