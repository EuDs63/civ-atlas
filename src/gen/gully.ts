/**
 * 山坡上冲出来的沟和山脊(只在画的时候算,世界数据不变):顺着坡往下拉出一道道条纹,横着坡起伏 ——
 * 像雨水冲刷出来的沟壑。做法是游戏地形里常用的"冲刷噪声":
 *   - 一层 = 三维空间里一格一个抖动点,每个点放一组沿坡向伸展的余弦条纹(横着坡向起伏),按距离加权混起来;
 *     相邻格的条纹相位不同,混在一起分叉、汇合,像流水切出的沟
 *   - 一层层往细里叠(格子减半、幅度乘 0.45),每层的坡向 = 原来的坡 + 前面几层沟壑自己的坡 ——
 *     细的沟顺着粗沟的沟壁往下走,而不是都朝山下平行
 * 位置用球面上的三维坐标(世界单位),东西没有接缝、两极不拉丝。
 * 纯计算:不碰页面,worker / Node 都能跑;同一个种子、同一个位置结果一样。
 */

const TAU = 2 * Math.PI;
/** cos / sin 查找表(一圈 1024 格,线性插值) */
const LUT_N = 1024;
const COS = new Float32Array(LUT_N + 1);
const SIN = new Float32Array(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) {
  COS[i] = Math.cos((i / LUT_N) * TAU);
  SIN[i] = Math.sin((i / LUT_N) * TAU);
}

/** 最粗一层的格子(世界单位;一个默认精细度的地块约 7.6) */
const CELL0 = 5;
/** 每往细一层,幅度乘多少 */
const GAIN = 0.45;
/** 最多几层 */
const MAX_OCT = 7;
/** 一层的格子小于这么多个像素就不叠了(再细就是噪点) */
const MIN_PX = 2;
/** 幅度不到这么多米就不再往细里叠 */
const MIN_AMP = 1.5;

function hash3(seed: number, x: number, y: number, z: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= Math.imul(y | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= Math.imul(z | 0, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f);
  h ^= h >>> 15;
  return h >>> 0;
}

/** 每个方向看前后各两格(核的半径 √3 格,前后一格不够:跨过格子边时会突然多出、少掉几个点,起伏断开) */
const NB = 5;
/** 查询点在本格里的位置 f(0..1)时,往前 / 往后第几格(0..4 = −2..+2)整格离它最近的距离平方(只看这一个方向) */
function gapsOf(f: number, out: Float64Array): void {
  out[0] = (f + 1) * (f + 1);
  out[1] = f * f;
  out[2] = 0;
  out[3] = (1 - f) * (1 - f);
  out[4] = (2 - f) * (2 - f);
}

/** 一层冲刷噪声。相邻像素多半落在同一格:记住上一次的格子和周围 5 × 5 × 5 格的抖动点 */
class Layer {
  private cx = NaN;
  private cy = NaN;
  private cz = NaN;
  /** 周围各格抖动点相对本格原点的位置 */
  private readonly jx = new Float64Array(NB * NB * NB);
  private readonly jy = new Float64Array(NB * NB * NB);
  private readonly jz = new Float64Array(NB * NB * NB);
  private readonly gx = new Float64Array(NB);
  private readonly gy = new Float64Array(NB);
  private readonly gz = new Float64Array(NB);
  constructor(private readonly seed: number) {}

  /**
   * (px, py, pz) 处(以格为单位)的值,写进 out = [值 −1..1, 对位置的梯度 x, y, z(每格)];
   * (dx, dy, dz) = 横着坡向的单位方向(条纹沿坡向伸展,沿这个方向起伏)
   */
  at(px: number, py: number, pz: number, dx: number, dy: number, dz: number, out: Float64Array): void {
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const iz = Math.floor(pz);
    const { jx, jy, jz } = this;
    if (ix !== this.cx || iy !== this.cy || iz !== this.cz) {
      this.cx = ix;
      this.cy = iy;
      this.cz = iz;
      let q = 0;
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++)
          for (let k = -2; k <= 2; k++, q++) {
            const hh = hash3(this.seed, ix + i, iy + j, iz + k);
            jx[q] = i + (hh & 1023) / 1024;
            jy[q] = j + ((hh >>> 10) & 1023) / 1024;
            jz[q] = k + ((hh >>> 20) & 1023) / 1024;
          }
    }
    const fx = px - ix;
    const fy = py - iy;
    const fz = pz - iz;
    // 每个方向第几格整格离查询点最近多远(平方);整格都在核外面的跳过
    const { gx, gy, gz } = this;
    gapsOf(fx, gx);
    gapsOf(fy, gy);
    gapsOf(fz, gz);
    let wt = 0;
    let h = 0;
    let g = 0;
    for (let i = 0; i < NB; i++) {
      const ax = gx[i];
      if (ax >= 3) continue;
      for (let j = 0; j < NB; j++) {
        const axy = ax + gy[j];
        if (axy >= 3) continue;
        for (let k = 0; k < NB; k++) {
          if (axy + gz[k] >= 3) continue;
          const q = (i * NB + j) * NB + k;
          const vx = fx - jx[q];
          const vy = fy - jy[q];
          const vz = fz - jz[q];
          const d2 = vx * vx + vy * vy + vz * vz;
          if (d2 >= 3) continue;
          const t = 1 - d2 / 3;
          const w = t * t * t;
          wt += w;
          // 条纹的相位 = 到抖动点的位移在"横着坡"方向上的投影(一格一个周期)
          let m = vx * dx + vy * dy + vz * dz;
          m -= Math.floor(m);
          const f = m * LUT_N;
          const i0 = f | 0;
          const a = f - i0;
          h += (COS[i0] + (COS[i0 + 1] - COS[i0]) * a) * w;
          g -= (SIN[i0] + (SIN[i0 + 1] - SIN[i0]) * a) * w;
        }
      }
    }
    const inv = wt > 0 ? 1 / wt : 0;
    out[0] = h * inv;
    // 梯度只算条纹本身的(权重随位置的变化忽略:够用来让下一层顺着沟壁走)
    const s = g * inv * TAU;
    out[1] = s * dx;
    out[2] = s * dy;
    out[3] = s * dz;
  }
}

/** 一个世界的沟壑噪声(各层各一个种子) */
export class Gullies {
  private readonly layers: Layer[];
  private readonly buf = new Float64Array(4);
  constructor(seed: number) {
    this.layers = Array.from({ length: MAX_OCT }, (_, i) => new Layer((seed + Math.imul(i + 1, 0x632be5ab)) >>> 0));
  }

  /**
   * 球面上一点的沟和山脊起伏(米,有正有负)。
   *   (X, Y, Z):位置(世界单位);(ex, ey):当地朝东的单位方向(z 分量是 0);(nx, ny, nz):朝北的单位方向;
   *   (ge, gn):当地往东、往北的坡度(米 / 世界单位);amp:最粗一层的幅度(米);scale:像素 / 世界单位(决定叠到多细)
   */
  height(X: number, Y: number, Z: number, ex: number, ey: number, nx: number, ny: number, nz: number, ge: number, gn: number, amp: number, scale: number): number {
    const B = this.buf;
    let out = 0;
    let a = amp;
    let cs = CELL0;
    for (let oc = 0; oc < MAX_OCT && cs * scale >= MIN_PX && a > MIN_AMP; oc++) {
      const m = Math.sqrt(ge * ge + gn * gn);
      if (m < 1e-6) break;
      // 横着坡的方向(坡向转 90°),换成三维
      const pe = -gn / m;
      const pn = ge / m;
      this.layers[oc].at(X / cs, Y / cs, Z / cs, pe * ex + pn * nx, pe * ey + pn * ny, pn * nz, B);
      out += a * B[0];
      // 这一层自己的坡(米 / 世界单位)叠进去,下一层顺着它走
      const sx = (B[1] * a) / cs;
      const sy = (B[2] * a) / cs;
      const sz = (B[3] * a) / cs;
      ge += sx * ex + sy * ey;
      gn += sx * nx + sy * ny + sz * nz;
      a *= GAIN;
      cs *= 0.5;
    }
    return out;
  }
}

/** 整张主图(w × h,等距圆柱)上一批像素的沟壑:要算的像素和它们的坡、幅度(见 gen/raster.ts 的 GullyJob) */
export interface GullyInput {
  seed: number;
  w: number;
  h: number;
  /** 球半径(世界单位) */
  R: number;
  /** 像素 / 世界单位 */
  scale: number;
  /** 像素下标(按行排好) */
  idx: Int32Array;
  /** 柔化海拔往东、往北的坡(米 / 世界单位) */
  ge: Float32Array;
  gn: Float32Array;
  /** 最粗一层沟壑的幅度(米) */
  amp: Float32Array;
}

/**
 * 第 from ~ to − 1 个像素的沟壑起伏(米)。纯计算:可以分段交给几个后台线程,结果和一次算完一样。
 * 像素中心的经纬度和铺像素(gen/raster.ts 的 sphereGrid)同一个算法、同样存成 Float32
 */
export function gullyHeights(j: GullyInput, from: number, to: number): Float32Array {
  const { w, h, R, scale, idx, ge, gn, amp } = j;
  const cosLon = new Float32Array(w);
  const sinLon = new Float32Array(w);
  const cosLat = new Float32Array(h);
  const sinLat = new Float32Array(h);
  for (let px = 0; px < w; px++) {
    const l = ((px + 0.5) / w) * 2 * Math.PI - Math.PI;
    cosLon[px] = Math.cos(l);
    sinLon[px] = Math.sin(l);
  }
  for (let py = 0; py < h; py++) {
    const l = Math.PI / 2 - ((py + 0.5) / h) * Math.PI;
    cosLat[py] = Math.cos(l);
    sinLat[py] = Math.sin(l);
  }
  const gl = new Gullies(j.seed);
  const out = new Float32Array(Math.max(0, to - from));
  for (let i = from; i < to; i++) {
    const k = idx[i];
    const py = (k / w) | 0;
    const px = k - py * w;
    const cl = cosLat[py];
    const sl = sinLat[py];
    const cL = cosLon[px];
    const sL = sinLon[px];
    out[i - from] = gl.height(cl * cL * R, cl * sL * R, sl * R, -sL, cL, -sl * cL, -sl * sL, cl, ge[i], gn[i], amp[i], scale);
  }
  return out;
}
