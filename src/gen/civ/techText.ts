/**
 * 技术层的文字:发明 / 传播写成编年史条目(和宗教大事一样,不进 buildChronicle,并进 fullChronicle)。
 *
 *   - 发明:「大渭始兴冶铁」;气质鲜明时带一句口吻「好战的大渭始制火器」
 *   - 战争传播:「大昌自索拉特军中得火器」
 *   - 商路传播:「印刷术循商路传至瑞国」
 *
 * 重要度沿用 TechEvent.importance(发明大事多为 3,传入 1–2)。
 */
import type { Civ, TechEvent, TechTemperament, Year } from './types';
import { polityName } from './growth';
import type { ChronicleEntry, Importance } from './chronicle';
import { techLabel } from './tech';

/** 技术纪事的一字标签 */
const TAG: Record<TechEvent['kind'], string> = { invent: '技', spread: '播' };

/** 写进发明句里的气质(只挑好战 / 商路发达 / 开疆 / 兼收并蓄,其余不抢戏) */
const TONE: readonly TechTemperament[] = ['好战', '商路发达', '开疆', '兼收并蓄'];

const polName = (civ: Civ, p: number, y: Year) => (p >= 0 && civ.polities[p] ? polityName(civ.polities[p], y) : '某国');

function toneOf(civ: Civ, polity: number): string {
  const tp = civ.tech?.polities[polity];
  if (!tp) return '';
  for (const t of TONE) if (tp.temperaments.includes(t)) return t;
  return '';
}

/** 一件技术大事写成一句 */
export function techEventText(civ: Civ, e: TechEvent): string {
  const name = techLabel(e.tech);
  const A = polName(civ, e.polity, e.year);
  const tone = toneOf(civ, e.polity);
  if (e.kind === 'invent') {
    if (tone === '好战') return `好战的${A}始制${name}`;
    if (tone === '商路发达') return `商路畅通的${A}首创${name}`;
    if (tone === '开疆') return `开疆的${A}始兴${name}`;
    return `${A}始兴${name}`;
  }
  const B = e.from !== undefined ? polName(civ, e.from, e.year) : '邻国';
  if (e.via === 'war') {
    if (tone === '好战') return `好战的${A}自${B}军中得${name}`;
    return `${A}自${B}军中得${name}`;
  }
  if (tone === '商路发达' || tone === '兼收并蓄') return `${name}循商路传入${A}`;
  return `${name}循商路传至${A}`;
}

const entryCache = new WeakMap<Civ, ChronicleEntry[]>();

/**
 * 技术大事 → 编年史条目。kind = 'tech';
 * id = 史事条数 + 人物数 + 信仰大事数 + 第几件。没有技术层 = 空数组。按 civ 缓存
 */
export function techEntries(civ: Civ): ChronicleEntry[] {
  const hit = entryCache.get(civ);
  if (hit) return hit;
  const out: ChronicleEntry[] = [];
  const tech = civ.tech;
  if (tech?.events.length) {
    const n0 = (civ.annals?.length ?? 0) + (civ.people?.length ?? 0) + (civ.religion?.events.length ?? 0);
    tech.events.forEach((e, i) => {
      const polities = [e.polity];
      if (e.from !== undefined && e.from >= 0) polities.push(e.from);
      out.push({
        id: n0 + i,
        kind: 'tech',
        year: e.year,
        end: e.year,
        text: techEventText(civ, e),
        tag: TAG[e.kind],
        importance: e.importance as Importance,
        polities,
        regions: e.region >= 0 ? [e.region] : [],
        settlement: -1,
      });
    });
    out.sort((a, b) => a.year - b.year || a.id - b.id);
  }
  entryCache.set(civ, out);
  return out;
}
