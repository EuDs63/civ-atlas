/**
 * 助手列出来、还没执行的改地形:在星球上用白色虚线圈出来,旁边标编号(和助手确认单上的编号对上)。
 * 和地名一样只在星球停住时画(一动就藏起来)。火山、湖是一个圈;山脉、抬起陆地、沉成海沿着线圈一条两头圆的带子。
 * 圈的大小按这处修改影响的范围(世界坐标的半径)放大一点,太小的至少有十几个像素。
 */
import type { TerrainOp } from '../../gen/edits';
import { TERRAIN_W } from '../../gen/terrainEdits';
import type { World } from '../../gen/world';
import { globeLabelView, globeToCanvas } from '../../render/globeLabels';
import { labelProjection, mapProj } from '../../render/projection';
import type { StillPose } from './scene';

export interface PlanetMark {
  /** 编号(确认单上第几条) */
  n: number;
  op: TerrainOp;
}

/** 屏幕上至少多大(像素) */
const MIN_R = 14;
const BADGE_R = 10;

type Pt = [number, number];

/** 一处修改的轮廓(世界坐标)和编号放在哪 */
function outline(op: TerrainOp, R: number): { ring: Pt[]; badge: Pt; ref: number } {
  const q = op.pts;
  const n = q.length >> 1;
  const arc = (cx: number, cy: number, a0: number, a1: number, out: Pt[]) => {
    const steps = Math.max(6, Math.ceil((Math.abs(a1 - a0) / Math.PI) * 24));
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
  };
  if (n < 2) {
    const ring: Pt[] = [];
    arc(q[0], q[1], 0, Math.PI * 2, ring);
    // 右下角(世界坐标 y 朝南)
    return { ring, badge: [q[0] + R * Math.SQRT1_2, q[1] + R * Math.SQRT1_2], ref: q[0] };
  }
  // 折线的东西方向接着走(跨 180° 经线时不绕一大圈)
  const P: Pt[] = [[q[0], q[1]]];
  for (let i = 1; i < n; i++) {
    let x = q[2 * i];
    const px = P[i - 1][0];
    while (x - px > TERRAIN_W / 2) x -= TERRAIN_W;
    while (px - x > TERRAIN_W / 2) x += TERRAIN_W;
    P.push([x, q[2 * i + 1]]);
  }
  // 每个点的法线(相邻两段的方向取平均)
  const dir = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const d0 = dir(P[Math.max(0, i - 1)], P[Math.max(1, i)]);
    const d1 = dir(P[Math.min(n - 2, i)], P[Math.min(n - 1, i + 1)]);
    let nx = -(d0[1] + d1[1]);
    let ny = d0[0] + d1[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    left.push([P[i][0] + nx * R, P[i][1] + ny * R]);
    right.push([P[i][0] - nx * R, P[i][1] - ny * R]);
  }
  const ring: Pt[] = [...left];
  const de = dir(P[n - 2], P[n - 1]);
  const ae = Math.atan2(de[1], de[0]);
  arc(P[n - 1][0], P[n - 1][1], ae + Math.PI / 2, ae - Math.PI / 2, ring);
  ring.push(...right.reverse());
  const ds = dir(P[0], P[1]);
  const as = Math.atan2(ds[1], ds[0]);
  arc(P[0][0], P[0][1], as - Math.PI / 2, as - (Math.PI * 3) / 2, ring);
  // 编号在起点外侧
  return { ring, badge: [P[0][0] - ds[0] * R, P[0][1] - ds[1] * R], ref: P[0][0] };
}

/** 在 cv 上按 pose 画这几处(画布铺满视口);返回画了几处 */
export function drawPlanetMarks(cv: HTMLCanvasElement, marks: readonly PlanetMark[], pose: StillPose, world: World, dpr: number): number {
  const cw = Math.max(1, Math.round(pose.w * dpr));
  const ch = Math.max(1, Math.round(pose.h * dpr));
  if (cv.width !== cw || cv.height !== ch) {
    cv.width = cw;
    cv.height = ch;
  }
  const ctx = cv.getContext('2d');
  if (!ctx) return 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!marks.length) return 0;
  const W = world.width;
  const H = world.height;
  /** 世界坐标 → 画布像素;第三个数 > 0 = 看得见(地球仪的背面看不见) */
  let at: (x: number, y: number, ref: number) => [number, number, number];
  /** 一个世界单位在屏幕正中大约多少画布像素 */
  let unit: number;
  if (pose.proj === 'globe') {
    const lv = globeLabelView({ view: { lon: pose.lon, lat: pose.lat, k: 1 }, w: pose.w, h: pose.h, dpr, worldW: W, worldH: H, frame: { cx: pose.cx, cy: pose.cy, R: pose.k } });
    at = (x, y) => globeToCanvas(lv, x, y);
    unit = (2 * Math.PI * pose.k * dpr) / W;
  } else {
    const mp = mapProj(pose.proj, (pose.lon * 180) / Math.PI, W, H);
    const lp = labelProjection(mp);
    const r = (pose.k / mp.s) * dpr;
    const ox = pose.cx * dpr - (r * W) / 2;
    const oy = pose.cy * dpr - (r * H) / 2;
    at = (x, y, ref) => {
      const [mx, my] = lp.fwd(x, y, ref);
      return [ox + mx * r, oy + my * r, 1];
    };
    unit = r;
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let drawn = 0;
  const badges: { x: number; y: number; n: number }[] = [];
  for (const m of marks) {
    const R = Math.max(m.op.r * 1.25, (MIN_R * dpr) / unit);
    const { ring, badge, ref } = outline(m.op, R);
    ctx.beginPath();
    let pen = false;
    let any = false;
    for (const [x, y] of ring) {
      const [sx, sy, d] = at(x, y, ref);
      if (d <= 0.02) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(sx, sy);
      else ctx.moveTo(sx, sy);
      pen = true;
      any = true;
    }
    if (!any) continue;
    drawn++;
    ctx.save();
    ctx.setLineDash([7 * dpr, 5 * dpr]);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 3 * dpr;
    ctx.lineWidth = 2.2 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
    const [bx, by, bd] = at(badge[0], badge[1], ref);
    if (bd > 0.05) badges.push({ x: bx, y: by, n: m.n });
  }
  // 编号压在圈上面
  for (const b of badges) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, BADGE_R * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 4 * dpr;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = 'rgba(28, 28, 30, 0.85)';
    ctx.stroke();
    ctx.fillStyle = '#1c1c1e';
    ctx.font = `700 ${12 * dpr}px -apple-system, "PingFang SC", "Helvetica Neue", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(b.n), b.x, b.y + 0.5 * dpr);
  }
  return drawn;
}

/** 这几处的中心(经度、纬度,弧度;按球面上取平均):星球转过去正对着它 */
export function marksCenter(marks: readonly PlanetMark[], world: World): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const m of marks) {
    const q = m.op.pts;
    for (let i = 0; i + 1 < q.length; i += 2) {
      const lon = (q[i] / world.width) * Math.PI * 2 - Math.PI;
      const lat = Math.PI / 2 - (q[i + 1] / world.height) * Math.PI;
      sx += Math.cos(lat) * Math.cos(lon);
      sy += Math.cos(lat) * Math.sin(lon);
      sz += Math.sin(lat);
    }
  }
  const l = Math.hypot(sx, sy, sz);
  if (l < 1e-6) return null;
  return [Math.atan2(sy, sx), Math.asin(sz / l)];
}
