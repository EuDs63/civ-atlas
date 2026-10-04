/** 悬停信息里的文明部分:国家与最近城市、故城遗址(阶段 3 城市兴衰)、民族、州、宜居度。 */
import type { Civ } from '../gen/civ/types';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { KIND_INFO, cultureLabel, regionLabel, regionNamed } from '../gen/civ/display';
import { SETTLEMENT_RANKS, capitalAt, polityAlive, polityName, populationAt, populationLabel, ruinSites, settlementRank } from '../gen/civ/growth';
import { MinHeap } from '../gen/util';
import { getCivTime } from './civView';

/**
 * 宜居分(0..~40)换成 0–100 的分数给人看。用平方根拉开低端:
 * 荒漠 / 苔原约 15–20,草原约 40,温带沃野 75 以上,最好的河口平原接近 100。
 */
export function habitatScore(s: number): number {
  return Math.round(100 * Math.sqrt(Math.min(1, Math.max(0, s) / 36)));
}

export function habitatWord(score: number): string {
  if (score <= 0) return '不可居';
  if (score < 15) return '荒凉';
  if (score < 35) return '贫瘠';
  if (score < 55) return '尚可';
  if (score < 75) return '宜居';
  return '富饶';
}

let owners: Owners | undefined;
/** 州 → 先后建在这一州的城(阶段 3 城市兴衰:被毁了又重建的州有几座,同一时刻最多一座还在) */
const citiesOfRegion = new WeakMap<Civ, number[][]>();

/**
 * 离州 r 最近的、这一年还在的城(沿州图走,路程按两治所间的距离累加;本州有城就是本州的;被毁的城不算)。
 * 没有 = −1
 */
export function nearestSettlement(civ: Civ, r: number, year: number): number {
  let cities = citiesOfRegion.get(civ);
  if (!cities) {
    cities = Array.from({ length: civ.regions.count }, () => []);
    for (const s of civ.settlements) cities[s.region].push(s.id);
    citiesOfRegion.set(civ, cities);
  }
  const reg = civ.regions;
  const cityAt = (q: number) => {
    for (const id of cities![q]) if (populationAt(civ.settlements[id], year) > 0) return id;
    return -1;
  };
  const alive = (q: number) => cityAt(q) >= 0;
  if (alive(r)) return cityAt(r);
  const dist = new Map<number, number>([[r, 0]]);
  const heap = new MinHeap(32);
  heap.push(r, 0);
  // 只在同一片陆地上找(海峡、航线不算"附近")
  while (heap.size) {
    const q = heap.pop();
    const d = heap.lastPri;
    if (d > (dist.get(q) ?? Infinity)) continue;
    if (alive(q)) return cityAt(q);
    for (let k = reg.adjStart[q]; k < reg.adjStart[q + 1]; k++) {
      if (reg.adjKind[k] >= 3) continue;
      const j = reg.adj[k];
      const nd = d + reg.adjLen[k];
      if (nd < (dist.get(j) ?? Infinity)) {
        dist.set(j, nd);
        heap.push(j, nd);
      }
    }
  }
  return -1;
}

/**
 * 悬停信息的文明部分(按时间轴当前的年份):
 *   "东越王国 · 最近城市 渭阳(城,约 3.2 万人)"(有城镇时;没有国家的有人区显示"部落地带")
 *   "故城遗址 · 姑陀城(第 2334 年毁于兵火)"(这一州的城被毁了、还没重建时)
 *   "XX族 · 游牧民族"(这一年这里有人住时)
 *   "州名 · 第 N 州 · 宜居度 X(评语)"(州名在有人住以后才有;用户起的州名一直有)
 */
export function describeCiv(civ: Civ | null, cell: number): string[] {
  if (!civ || cell < 0 || cell >= civ.regions.of.length) return [];
  const r = civ.regions.of[cell];
  if (r < 0) return [];
  const score = habitatScore(civ.habitat.suitability[cell]);
  const lines: string[] = [];
  let named = false;
  if (civ.cultures.length) {
    const year = getCivTime().year ?? civ.endYear;
    owners = ownersAt(civ, year, owners);
    const cu = civ.cultures[owners.culture[r]];
    const po = civ.polities[owners.polity[r]];
    if (civ.settlements.length && (po || cu)) {
      const sid = nearestSettlement(civ, r, year);
      const who = po ? polityName(po, year) : '部落地带';
      if (sid >= 0) {
        const s = civ.settlements[sid];
        const pop = populationAt(s, year);
        const capital = civ.polities.some((p) => polityAlive(p, year) && capitalAt(p, year) === s.id);
        const rank = capital ? '国都' : SETTLEMENT_RANKS[settlementRank(pop)].name;
        lines.push(`${who} · 最近城市 ${s.name}(${rank},${populationLabel(pop)})`);
      } else lines.push(who);
    }
    // 阶段 3 城市兴衰:这一州的城被毁了、还没重建
    for (const s of ruinSites(civ, year)) {
      if (s.region === r) lines.push(`故城遗址 · ${s.name}(第 ${Math.floor(s.ended!)} 年毁于兵火)`);
    }
    if (cu) {
      lines.push(`${cultureLabel(cu)} · ${KIND_INFO[cu.kind].name}民族`);
      named = regionNamed(civ, r);
    }
  }
  // 用户起过名的州(阶段 4)什么时候都显示名字
  if (civ.regionNames?.[r]) named = true;
  const where = named ? `${regionLabel(civ, r)} · 第 ${r + 1} 州` : `第 ${r + 1} 州`;
  lines.push(`${where} · 宜居度 ${score}(${habitatWord(score)})`);
  return lines;
}
