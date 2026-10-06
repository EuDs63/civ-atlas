/**
 * 文明叠加层 · 城镇符号(画在视口文字层上):按建城年份出现,随人口升级(人口、分级见 gen/civ/growth.ts)。
 *
 *   写实:大小分级的圆点 —— 村是小暗点,镇 / 城是白心黑圈(越大越粗),大城是双圈;国都画带框的星
 *   手绘:国都是城堡(塔楼 + 城墙 + 小旗:放大到看得清时插本国的国旗,远看是本国颜色的小三角),大城 / 城是屋群,镇是单屋,村是墨点
 *   故城遗址(阶段 3 城市兴衰:毁了、还没重建的城):手绘是淡墨的塌城门(断柱 + 断门楣 + 碎石),写实是一圈淡淡的虚线小圈 —— 低调,不抢眼
 *
 * 符号画在和视口一样大的文字层画布上(CivLayer),按屏幕像素 × devicePixelRatio 画,放大地图后依然清晰;
 * 放大时符号只按 k^GROW 变大(不跟地图一起放大 k 倍)。
 * 哪些画、哪些藏由 render/labels/draw.ts 的 placeMap 和文字一起决定(labels/settlements.ts 定门槛和优先级):
 * 远景只画国都和城,放大才逐步出现镇、村;和别的符号、国名挤在一起的不画 —— 不会挤成一团。
 * "国家"或"道路"打开时画(路网连着城,不画城看不出路通到哪)。
 */
import type { Civ, Polity, Settlement } from '../../gen/civ/types';
import { capitalAt, populationAt, settlementRank } from '../../gen/civ/growth';
import { ruinRank, ruinSites } from '../../gen/civ/growth';
import type { PlacedMark } from '../labels/draw';
import type { CivStyle } from './overlay';
import type { Shape } from '../../gen/civ/flags';
import { shapePath } from '../flag/flagSvg';

/** 符号类别:0 村 / 1 镇 / 2 城 / 3 大城 / 4 国都 / 5 故城遗址(RUIN) */
export type SettlementKind = 0 | 1 | 2 | 3 | 4 | 5;
/** 故城遗址的符号类别 */
export const RUIN: SettlementKind = 5;

/** 放大地图时符号跟着长的幂:放大 4 倍时符号大 2 倍 */
export const SYMBOL_GROW = 0.5;

/**
 * 各类符号的外接框 [左, 上, 右, 下](符号单位 = 缩放 1 倍、参照宽度时的 CSS 像素;含描边)。
 * 手绘国都的小旗往上伸得高,框也高
 */
export const SYMBOL_BOX: Record<'fantasy' | 'realistic', [number, number, number, number][]> = {
  fantasy: [
    [1.1, 1.1, 1.1, 1.1],
    [2.1, 2.2, 2.1, 2.1],
    [3.7, 2.7, 3.7, 2.5],
    [4.4, 4.1, 4.4, 3.0],
    [5.0, 9.0, 5.0, 3.1],
    [3.2, 2.4, 3.2, 1.8],
  ],
  realistic: [
    [1.3, 1.3, 1.3, 1.3],
    [1.9, 1.9, 1.9, 1.9],
    [2.5, 2.5, 2.5, 2.5],
    [3.1, 3.1, 3.1, 3.1],
    [5.0, 5.0, 5.0, 5.0],
    [2.2, 2.2, 2.2, 2.2],
  ],
};

export interface SettlementAt {
  s: Settlement;
  kind: SettlementKind;
  pop: number;
  /** 国都所属国家的颜色(手绘风小旗用) */
  color?: [number, number, number];
  /** 国都所属的国家(手绘风插国旗用) */
  polity?: number;
}

/** 这一年有的城镇和它们的级别,按重要性排好(国都 → 大城 → 城 → 镇 → 村,同级人口多的在前) */
export function settlementsAt(civ: Civ, year: number): SettlementAt[] {
  const capitalOf = new Map<number, Polity>();
  for (const p of civ.polities) {
    if (year < p.founded || (p.ended !== undefined && year >= p.ended)) continue;
    capitalOf.set(capitalAt(p, year), p);
  }
  const list: SettlementAt[] = [];
  for (const s of civ.settlements) {
    const pop = populationAt(s, year);
    if (!(pop > 0)) continue;
    const p = capitalOf.get(s.id);
    list.push({ s, kind: p ? 4 : (settlementRank(pop) as SettlementKind), pop, color: p?.color, polity: p?.id });
  }
  list.sort((a, b) => b.kind - a.kind || b.pop - a.pop || a.s.id - b.s.id);
  return list;
}

/**
 * 这一年地图上的故城遗址(阶段 3 城市兴衰:毁了、还没在故址上重建起新城的城),
 * rank = 被毁前的级别(0 村 … 3 大城:大城的遗址远一点就看得见,村子的放大很多才出现),大的在前
 */
export function ruinsAt(civ: Civ, year: number): { s: Settlement; rank: number }[] {
  return ruinSites(civ, year)
    .map((s) => ({ s, rank: Math.max(0, ruinRank(s)) }))
    .sort((a, b) => b.rank - a.rank || a.s.id - b.s.id);
}

/** 视口层上放好的一个城镇符号(placeMap 的结果 + 城镇信息) */
export interface SettlementMarkInfo {
  kind: SettlementKind;
  color?: [number, number, number];
  polity?: number;
}

/** 手绘国都插的国旗:某国的旗(还没有 = null,画本国颜色的小三角);旗宽不到 minPx(画布像素)时也画小三角 */
export interface CapitalFlags {
  flag: (polity: number) => { image: CanvasImageSource; shape: Shape } | null;
  minPx: number;
}

// ---- 手绘符号(单位:符号单位 u;中心在 (0, 0),底边约在 y = +2) ----

/** 单屋:五边形屋子 */
function house(pa: CanvasPath, x: number, y: number, u: number) {
  pa.moveTo(x - 1.9 * u, y - 0.4 * u);
  pa.lineTo(x, y - 2.3 * u);
  pa.lineTo(x + 1.9 * u, y - 0.4 * u);
  pa.lineTo(x + 1.5 * u, y - 0.4 * u);
  pa.lineTo(x + 1.5 * u, y + 1.7 * u);
  pa.lineTo(x - 1.5 * u, y + 1.7 * u);
  pa.lineTo(x - 1.5 * u, y - 0.4 * u);
  pa.closePath();
}

/** 尖顶塔 */
function tower(pa: CanvasPath, x: number, y: number, u: number) {
  pa.moveTo(x - 0.9 * u, y + 1.8 * u);
  pa.lineTo(x - 0.9 * u, y - 2.4 * u);
  pa.lineTo(x, y - 4.2 * u);
  pa.lineTo(x + 0.9 * u, y - 2.4 * u);
  pa.lineTo(x + 0.9 * u, y + 1.8 * u);
  pa.closePath();
}

/** 城堡轮廓:两座带垛口的塔楼 + 城墙 + 中间更高的主楼 */
const CASTLE: [number, number][] = [
  [-4.4, 2.6],
  [-4.4, -3.4],
  [-3.8, -3.4],
  [-3.8, -4.2],
  [-3.2, -4.2],
  [-3.2, -3.4],
  [-2.6, -3.4],
  [-2.6, -4.2],
  [-2.0, -4.2],
  [-2.0, -1.0],
  [-1.3, -1.0],
  [-1.3, -4.6],
  [-0.65, -4.6],
  [-0.65, -5.3],
  [0.0, -5.3],
  [0.0, -4.6],
  [0.65, -4.6],
  [0.65, -5.3],
  [1.3, -5.3],
  [1.3, -1.0],
  [2.0, -1.0],
  [2.0, -4.2],
  [2.6, -4.2],
  [2.6, -3.4],
  [3.2, -3.4],
  [3.2, -4.2],
  [3.8, -4.2],
  [3.8, -3.4],
  [4.4, -3.4],
  [4.4, 2.6],
];
function castle(pa: CanvasPath, x: number, y: number, u: number) {
  pa.moveTo(x + CASTLE[0][0] * u, y + CASTLE[0][1] * u);
  for (let i = 1; i < CASTLE.length; i++) pa.lineTo(x + CASTLE[i][0] * u, y + CASTLE[i][1] * u);
  pa.closePath();
}

function star(pa: CanvasPath, x: number, y: number, r: number) {
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.42 : r;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i) pa.lineTo(px, py);
    else pa.moveTo(px, py);
  }
  pa.closePath();
}

function circle(pa: CanvasPath, x: number, y: number, r: number) {
  pa.moveTo(x + r, y);
  pa.arc(x, y, r, 0, Math.PI * 2);
}

/**
 * 故城遗址(手绘):一座塌了的城门 —— 左边的门柱还连着半截断掉的门楣,右边的门柱只剩一截,
 * 门洞里一块倒下的石块。单位 u = 符号单位;底边在 y = +1.3
 */
const RUIN_STONES: [number, number][][] = [
  // 左门柱 + 断掉的门楣
  [
    [-2.1, 1.3],
    [-2.1, -1.9],
    [0.5, -1.9],
    [0.3, -1.5],
    [0.55, -1.25],
    [-1.25, -1.25],
    [-1.25, 1.3],
  ],
  // 右门柱(断了半截)
  [
    [1.0, 1.3],
    [1.0, -0.55],
    [1.35, -0.95],
    [1.55, -0.6],
    [1.9, -0.85],
    [1.9, 1.3],
  ],
  // 门洞里倒下的石块
  [
    [-0.35, 1.3],
    [-0.25, 0.8],
    [0.45, 0.68],
    [0.6, 1.3],
  ],
];
function ruinStones(pa: CanvasPath, x: number, y: number, u: number) {
  for (const st of RUIN_STONES) {
    pa.moveTo(x + st[0][0] * u, y + st[0][1] * u);
    for (let i = 1; i < st.length; i++) pa.lineTo(x + st[i][0] * u, y + st[i][1] * u);
    pa.closePath();
  }
}

/**
 * 画放好的城镇符号(视口文字层,画布像素)。placed[i].mark 是 settlementMarks 给的符号(带 kind / color / polity);
 * placed[i].s = 符号单位 → 画布像素。flags = 手绘国都插的国旗(不给 = 都画小三角)
 */
export function drawSettlementMarks(ctx: CanvasRenderingContext2D, placed: PlacedMark[], style: CivStyle, flags?: CapitalFlags): void {
  if (!placed.length) return;
  const info = (m: PlacedMark) => m.mark as unknown as SettlementMarkInfo;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // 先画遗址,再画小的,大的压在上面
  const layer = (k: SettlementKind) => (k === RUIN ? -1 : k);
  const order = [...placed].sort((a, b) => layer(info(a).kind) - layer(info(b).kind));
  if (style === 'fantasy') {
    // 符号底下先垫一层淡淡的纸色,穿过树林、山峰时也看得清
    const halo = new Path2D();
    const dots = new Path2D();
    const dotHalo = new Path2D();
    for (const e of order) {
      const S = e.s;
      const k = info(e).kind;
      if (k === RUIN) continue;
      if (k === 0) {
        circle(dotHalo, e.x, e.y, 1.5 * S);
        circle(dots, e.x, e.y, 0.95 * S);
      } else circle(halo, e.x, e.y + 0.2 * S, [0, 2.6, 3.7, 4.5, 5.6][k] * S);
    }
    ctx.fillStyle = 'rgba(244,234,210,0.62)';
    ctx.fill(halo);
    ctx.fillStyle = 'rgba(244,234,210,0.5)';
    ctx.fill(dotHalo);
    const INK = 'rgba(52,34,22,0.95)';
    const PAPER = 'rgba(246,238,216,0.97)';
    ctx.fillStyle = 'rgba(52,34,22,0.92)';
    ctx.fill(dots);
    ctx.strokeStyle = INK;
    // 屋子一间间画,后排先画、前排后画,前排挡住后排的轮廓
    const shape = (draw: (pa: CanvasPath) => void) => {
      ctx.beginPath();
      draw(ctx);
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.stroke();
    };
    for (const e of order) {
      const { x, y } = e;
      const S = e.s;
      const { kind, color, polity } = info(e);
      ctx.lineWidth = 0.62 * S;
      switch (kind) {
        case RUIN: {
          // 淡墨的塌城门:纸色垫底、半透明的墨线,地上一道短地平线、两块碎石
          const u = 1.1 * S;
          ctx.beginPath();
          circle(ctx, x, y + 0.1 * S, 2.9 * S);
          ctx.fillStyle = 'rgba(244,234,210,0.45)';
          ctx.fill();
          ctx.beginPath();
          ruinStones(ctx, x, y, u);
          ctx.fillStyle = 'rgba(238,226,198,0.85)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(70,48,32,0.72)';
          ctx.lineWidth = 0.46 * S;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x - 2.8 * u, y + 1.32 * u);
          ctx.lineTo(x + 2.8 * u, y + 1.32 * u);
          ctx.lineWidth = 0.34 * S;
          ctx.stroke();
          ctx.beginPath();
          circle(ctx, x + 2.45 * u, y + 1.05 * u, 0.24 * u);
          circle(ctx, x - 2.55 * u, y + 1.1 * u, 0.2 * u);
          ctx.fillStyle = 'rgba(70,48,32,0.62)';
          ctx.fill();
          ctx.strokeStyle = INK;
          break;
        }
        case 1:
          shape((pa) => house(pa, x, y + 0.3 * S, 0.95 * S));
          break;
        case 2:
          shape((pa) => house(pa, x, y - 0.3 * S, 0.9 * S));
          shape((pa) => house(pa, x - 1.9 * S, y + 0.9 * S, 0.78 * S));
          shape((pa) => house(pa, x + 1.9 * S, y + 0.9 * S, 0.78 * S));
          break;
        case 3:
          shape((pa) => tower(pa, x, y + 0.2 * S, 0.95 * S));
          shape((pa) => house(pa, x - 1.6 * S, y + 0.2 * S, 0.72 * S));
          shape((pa) => house(pa, x + 1.7 * S, y + 0.4 * S, 0.72 * S));
          shape((pa) => house(pa, x - 2.6 * S, y + 1.4 * S, 0.78 * S));
          shape((pa) => house(pa, x + 2.6 * S, y + 1.4 * S, 0.78 * S));
          break;
        case 4: {
          const u = 1.05 * S;
          shape((pa) => castle(pa, x, y, u));
          // 城门
          ctx.beginPath();
          ctx.moveTo(x - 0.8 * u, y + 2.6 * u);
          ctx.lineTo(x - 0.8 * u, y + 1.2 * u);
          ctx.arc(x, y + 1.2 * u, 0.8 * u, Math.PI, 0);
          ctx.lineTo(x + 0.8 * u, y + 2.6 * u);
          ctx.closePath();
          ctx.fillStyle = INK;
          ctx.fill();
          // 放大到看得清:旗杆 + 本国的国旗(宽约城堡的六七成,下沿略高过城楼,墨线描边)
          const fw = 5.6 * u;
          const fl = flags && polity !== undefined && fw >= flags.minPx ? flags.flag(polity) : null;
          if (fl) {
            const fh = (fw * 2) / 3;
            const fx = x + 0.33 * u;
            const fy = y - 5.6 * u - fh;
            ctx.beginPath();
            ctx.moveTo(fx, y - 5.3 * u);
            ctx.lineTo(fx, fy);
            ctx.lineWidth = 0.5 * S;
            ctx.stroke();
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.25)';
            ctx.shadowBlur = 0.4 * S;
            ctx.shadowOffsetY = 0.25 * S;
            ctx.drawImage(fl.image, fx, fy, fw, fh);
            ctx.restore();
            ctx.save();
            ctx.translate(fx, fy);
            ctx.scale(fw / 300, fh / 200);
            ctx.lineWidth = (0.2 * S * 300) / fw;
            ctx.strokeStyle = 'rgba(40,30,20,0.7)';
            ctx.stroke(new Path2D(shapePath(fl.shape)));
            ctx.restore();
            break;
          }
          // 远看:旗杆 + 本国颜色的小三角
          ctx.beginPath();
          ctx.moveTo(x + 0.33 * u, y - 5.3 * u);
          ctx.lineTo(x + 0.33 * u, y - 8.2 * u);
          ctx.lineWidth = 0.5 * S;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + 0.33 * u, y - 8.2 * u);
          ctx.lineTo(x + 2.9 * u, y - 7.5 * u);
          ctx.lineTo(x + 0.33 * u, y - 6.7 * u);
          ctx.closePath();
          const c = color ?? [150, 60, 50];
          ctx.fillStyle = `rgb(${Math.round(c[0] * 0.85)},${Math.round(c[1] * 0.85)},${Math.round(c[2] * 0.85)})`;
          ctx.fill();
          ctx.lineWidth = 0.4 * S;
          ctx.stroke();
          break;
        }
      }
    }
  } else {
    // 按线宽分组,一组一次描边
    for (const e of order) {
      const { x, y } = e;
      const S = e.s;
      const { kind } = info(e);
      switch (kind) {
        case RUIN:
          // 一圈淡淡的虚线小圈(城没了,只剩一个轮廓)+ 中间一个小点
          ctx.beginPath();
          circle(ctx, x, y, 2.1 * S);
          ctx.fillStyle = 'rgba(255,250,240,0.3)';
          ctx.fill();
          ctx.beginPath();
          circle(ctx, x, y, 1.75 * S);
          ctx.setLineDash([0.8 * S, 0.62 * S]);
          ctx.strokeStyle = 'rgba(40,30,26,0.66)';
          ctx.lineWidth = 0.5 * S;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          circle(ctx, x, y, 0.36 * S);
          ctx.fillStyle = 'rgba(40,30,26,0.6)';
          ctx.fill();
          break;
        case 0:
          ctx.beginPath();
          circle(ctx, x, y, 1.25 * S);
          ctx.fillStyle = 'rgba(255,250,240,0.45)';
          ctx.fill();
          ctx.beginPath();
          circle(ctx, x, y, 0.75 * S);
          ctx.fillStyle = 'rgba(34,24,20,0.78)';
          ctx.fill();
          break;
        case 1:
        case 2:
        case 3: {
          const r = [0, 1.45, 2.0, 2.55][kind];
          ctx.beginPath();
          circle(ctx, x, y, r * S);
          ctx.fillStyle = 'rgba(255,253,248,0.97)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(30,22,20,0.92)';
          ctx.lineWidth = [0, 0.75, 0.95, 1.1][kind] * S;
          ctx.stroke();
          if (kind === 3) {
            ctx.beginPath();
            circle(ctx, x, y, 1.05 * S);
            ctx.fillStyle = 'rgba(30,22,20,0.92)';
            ctx.fill();
          }
          break;
        }
        case 4:
          // 国都:白底圆框 + 深红五角星
          ctx.beginPath();
          circle(ctx, x, y, 4.3 * S);
          ctx.fillStyle = 'rgba(255,253,248,0.97)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(30,22,20,0.95)';
          ctx.lineWidth = 1.25 * S;
          ctx.stroke();
          ctx.beginPath();
          star(ctx, x, y, 3.25 * S);
          ctx.fillStyle = 'rgba(150,28,30,0.95)';
          ctx.fill();
          break;
      }
    }
  }
  ctx.restore();
}
