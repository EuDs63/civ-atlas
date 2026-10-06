/**
 * 作者标记的文字(卡片、世界概览、搜索、复制、悬停小卡片共用):年份、在哪、那几年归谁、那几年那里发生的事。
 * 位置怎么对到这个世界的州 / 城:几个州按州键(gen/edits.ts 的 regionOfKey),一个点按它落在哪个地块。
 */
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import type { ChronicleEntry } from '../gen/civ/chronicle';
import { fullChronicle } from '../gen/civ/religionText';
import { regionLabel } from '../gen/civ/display';
import { polityName } from '../gen/civ/growth';
import { markShownAt, regionOfKey, type AuthorMark } from '../gen/edits';
import { ownersOf } from './panelData';
import type { HoverInfo } from './hoverInfo';
import { MARK_HEX, markAreaShape, type AreaShape, type MarkItem } from '../render/marks';

/** "2506–2515 年" / "2498 年起" */
export function markYears(m: Pick<AuthorMark, 'from' | 'to'>): string {
  return m.to === undefined ? `${m.from} 年起` : `${m.from}–${m.to} 年`;
}

/** 世界坐标 → 地块(地图外 = −1) */
export function cellAtWorld(world: World, raster: Raster | null, x: number, y: number): number {
  if (!raster) return -1;
  const W = world.width;
  const xx = x - W * Math.floor(x / W);
  const px = Math.min(raster.w - 1, Math.max(0, Math.floor(xx * raster.scale)));
  const py = Math.min(raster.h - 1, Math.max(0, Math.floor(y * raster.scale)));
  return raster.cell[py * raster.w + px] ?? -1;
}

/** 几个州的标记:州键 → 这个世界里的州号(找不到的、重复的去掉) */
export function markRegionIds(civ: Civ, m: Pick<AuthorMark, 'regions'>): number[] {
  const out: number[] = [];
  for (const k of m.regions ?? []) {
    const r = regionOfKey(k, civ.regions.of);
    if (r >= 0 && r < civ.regions.count && !out.includes(r)) out.push(r);
  }
  return out;
}

/** 一个点落在哪:城(离那一点不到一个半地块的城,挑最近的)、有名字的山 / 岛 / 荒漠(没挨着城时)、州、海(都没有 = 不给) */
export interface MarkSpot {
  city?: number;
  /** civ.places 里的号 */
  place?: number;
  region?: number;
  sea?: string;
}

/** 一点到一条折线(x,y,x,y…,东西相连)最近的距离的平方 */
function pathDist2(path: Float32Array, at: readonly [number, number], W: number): number {
  // 每个点挪到离 at 最近的那一圈
  const wrap = (x: number) => x - W * Math.round((x - at[0]) / W);
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const ax = wrap(path[i]);
    const ay = path[i + 1];
    if (i + 3 >= path.length) {
      best = Math.min(best, (ax - at[0]) ** 2 + (ay - at[1]) ** 2);
      break;
    }
    const bx = wrap(path[i + 2]);
    const by = path[i + 3];
    const vx = bx - ax;
    const vy = by - ay;
    const l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((at[0] - ax) * vx + (at[1] - ay) * vy) / l2)) : 0;
    best = Math.min(best, (ax + t * vx - at[0]) ** 2 + (ay + t * vy - at[1]) ** 2);
  }
  return best;
}

export function markSpot(civ: Civ, world: World, raster: Raster | null, at: readonly [number, number], year: number): MarkSpot {
  const c = cellAtWorld(world, raster, at[0], at[1]);
  const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
  const out: MarkSpot = {};
  const W = world.width;
  const near = (world.mesh.spacing * 1.5) ** 2;
  // 旁边的城:这一年还在的优先(毁了又重建的,同一处有新旧两座,认新的),再按远近
  let bd = Infinity;
  let bAlive = false;
  for (const s of civ.settlements) {
    if (s.founded > year) continue;
    const dx = Math.abs(world.mesh.x[s.cell] - at[0]);
    const d = Math.min(dx, W - dx) ** 2 + (world.mesh.y[s.cell] - at[1]) ** 2;
    if (d >= near) continue;
    const alive = s.ended === undefined || s.ended > year;
    if ((alive && !bAlive) || (alive === bAlive && d < bd)) {
      bd = d;
      bAlive = alive;
      out.city = s.id;
    }
  }
  if (r >= 0) {
    out.region = r;
    // 没挨着城时:落在有名字的山(离山脊线三个地块以内)、岛、荒漠(离标注线不超过它的大小)上 = 那个名字
    if (out.city === undefined) {
      let best = 1;
      civ.places.forEach((p, id) => {
        const reach = p.kind === 'mountains' ? world.mesh.spacing * 3 : p.kind === 'island' || p.kind === 'desert' ? (p.size ?? 0) : 0;
        if (!reach || !p.path.length) return;
        const d = Math.sqrt(pathDist2(p.path, at, W)) / reach;
        if (d < best) {
          best = d;
          out.place = id;
        }
      });
    }
  } else {
    // 海上:离得最近的那片海(标注弧上的点到这一点的距离,不超过这片海的大小)
    let sd = Infinity;
    for (const p of civ.places) {
      if (p.kind !== 'sea') continue;
      for (let i = 0; i + 1 < p.path.length; i += 2) {
        const dx = Math.abs(p.path[i] - at[0]);
        const d = Math.min(dx, W - dx) ** 2 + (p.path[i + 1] - at[1]) ** 2;
        if (d < sd && d < ((p.size ?? 0) * 1.6) ** 2) {
          sd = d;
          out.sea = p.name;
        }
      }
    }
  }
  return out;
}

/** 几个州写成一句:"赤云泽、东荒、竹涛谷等 6 州";三个以内都写上:"紫月洲、银竹泽 2 州" */
export function regionsText(civ: Civ, ids: readonly number[]): string {
  if (!ids.length) return '这几州现在找不到了';
  const names = ids.map((r) => regionLabel(civ, r));
  return ids.length <= 3 ? `${names.join('、')} ${ids.length} 州` : `${names.slice(0, 3).join('、')}等 ${ids.length} 州`;
}

/** 一个点在哪,写成一句:"落烟渡，紫月洲" / "观月山" / "紫月洲" / "风暴海" / "海上" */
export function spotText(civ: Civ, s: MarkSpot): string {
  const parts: string[] = [];
  const place = s.place !== undefined ? civ.places[s.place] : undefined;
  if (s.city !== undefined && civ.settlements[s.city]) parts.push(civ.settlements[s.city].name);
  else if (place) return place.name;
  if (s.region !== undefined) parts.push(regionLabel(civ, s.region));
  if (!parts.length) parts.push(s.sea ?? '海上');
  return parts.join('，');
}

/** 标记在哪,写成一句(几个州 / 一个点) */
export function markPlaceText(civ: Civ, world: World, raster: Raster | null, m: AuthorMark, year: number): string {
  if (m.regions) return regionsText(civ, markRegionIds(civ, m));
  return m.at ? spotText(civ, markSpot(civ, world, raster, m.at, year)) : '';
}

/** 这几州 year 年归谁:[国家, 几州](按州数从多到少;无主的不算) */
export function markOwners(civ: Civ, ids: readonly number[], year: number): { polity: number; n: number }[] {
  const own = ownersOf(civ, year);
  const cnt = new Map<number, number>();
  for (const r of ids) {
    const p = own.polity[r];
    if (p >= 0) cnt.set(p, (cnt.get(p) ?? 0) + 1);
  }
  return [...cnt.entries()].map(([polity, n]) => ({ polity, n })).sort((a, b) => b.n - a.n || a.polity - b.polity);
}

/**
 * 标记那几年(from 到 to,含 to 那一年;没有 to = 到结束年份)、那几州发生的事:编年史里折叠的战争拆成一件一件,
 * 按年份从早到晚(EventList 显示最近的几条,新的在上)
 */
export function markEvents(civ: Civ, ids: readonly number[], m: Pick<AuthorMark, 'from' | 'to'>): ChronicleEntry[] {
  if (!ids.length || !civ.viable) return [];
  const set = new Set(ids);
  const end = m.to === undefined ? Infinity : m.to + 1;
  const out: ChronicleEntry[] = [];
  for (const e of fullChronicle(civ)) {
    for (const x of e.children?.length ? e.children : [e]) {
      if (x.year >= m.from && x.year < end && x.regions.some((r) => set.has(r))) out.push(x);
    }
  }
  return out.sort((a, b) => a.year - b.year);
}

/** 标记牵涉的州:几个州 = 那几州;一个点 = 它落在的那一州(海上 = 没有) */
export function markAllRegions(civ: Civ, world: World, raster: Raster | null, m: AuthorMark): number[] {
  if (m.regions) return markRegionIds(civ, m);
  const c = m.at ? cellAtWorld(world, raster, m.at[0], m.at[1]) : -1;
  const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
  return r >= 0 ? [r] : [];
}

/** 复制文字:名字、年份和地方、说明 */
export function markCopyText(civ: Civ, world: World, raster: Raster | null, m: AuthorMark, year: number): string {
  const head = `${markYears(m)}，${markPlaceText(civ, world, raster, m, year)}`;
  return [m.title, head, m.note ?? ''].filter(Boolean).join('\n');
}

/** 悬停在标记上的小卡片 */
export function markHover(m: AuthorMark): HoverInfo {
  return { color: MARK_HEX[m.color], name: m.title, sub: '作者标记', extra: `${markYears(m)}，点开看说明` };
}

/** 那一年的国名 */
export function ownerName(civ: Civ, polity: number, year: number): string {
  const p = civ.polities[polity];
  return p ? polityName(p, year) : '无主';
}

/**
 * 几个州的形状:按州划分存(同一份州划分、同一串州只算一次)。
 * draft = 正在填的那一份:一个个加州、去州时每次都不一样,只留最近的一份,不往缓存里堆
 */
const shapeCache = new WeakMap<object, Map<string, AreaShape | null>>();
let draftShape: { regions: object; key: string; shape: AreaShape | null } | null = null;

export function markShapeOf(world: World, civ: Civ, ids: readonly number[], draft = false): AreaShape | null {
  if (!ids.length) return null;
  const key = ids.join(',');
  let m = shapeCache.get(civ.regions);
  if (!m) shapeCache.set(civ.regions, (m = new Map()));
  if (m.has(key)) return m.get(key)!;
  if (draft) {
    if (draftShape?.regions !== civ.regions || draftShape.key !== key) draftShape = { regions: civ.regions, key, shape: markAreaShape(world.mesh, civ.regions, ids) };
    return draftShape.shape;
  }
  m.set(key, markAreaShape(world.mesh, civ.regions, ids));
  return m.get(key)!;
}

/** 这一年地图上有的标记,换成要画的样子(导出图片用;不分选中) */
export function markItemsAt(civ: Civ, world: World, marks: readonly AuthorMark[] | undefined, year: number): MarkItem[] {
  const out: MarkItem[] = [];
  for (const m of marks ?? []) {
    if (!markShownAt(m, year)) continue;
    out.push({ id: m.id, title: m.title, color: m.color, at: m.at, shape: m.regions ? markShapeOf(world, civ, markRegionIds(civ, m)) : undefined });
  }
  return out;
}
