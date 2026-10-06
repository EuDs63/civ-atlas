/**
 * 旗帜详情里的字:旗上每样东西的意思(一行一样)、底下那句"这面旗怎么来的"。规则见 flags.ts。
 * 名字(国名、城名、朝代、民族)按传进来的 Civ 现写:改了名,这里跟着变。纯计算,不碰 DOM。
 */
import type { Civ } from './types';
import { polityName } from './growth';
import { DE, LAYOUT_NAME, MARK_NAME, MARK_NOTE, SYM_NAME, TINCT, deOf, isEastern, type FlagBook, type FlagEra, type FlagSpec, type Seat, type Tinct } from './flags';

/** 一行:左边是什么(带色块的是颜色),右边什么意思 */
export interface FlagRow {
  k: string;
  v: string;
  /** 左边跟着的色块 */
  sw?: Tinct[];
}

const SEAT_WORD: Record<Seat, string> = {
  sea: '港口城',
  mountain: '山城',
  river: '河边的城',
  forest: '林中的城',
  dry: '草原、沙漠边的城',
  plain: '平原上的城',
};

const NUM = ['', '一', '两', '三'];

const tName = (t: Tinct) => TINCT[t].name;
const uniq = (ts: readonly Tinct[]) => [...new Set(ts)];
const joinNames = (ts: readonly Tinct[]) => uniq(ts).map(tName).join('、');
/** 颜色的说法:"红色",天蓝、金这类本身就是两个字的也加"色" */
const colorWord = (t: Tinct) => `${tName(t)}色`;

/** 国家的简称(那时候的国名) */
function nameAt(civ: Civ, id: number, year?: number): string {
  const p = civ.polities[id];
  if (!p) return '';
  const end = Math.min(p.ended ?? civ.endYear, civ.endYear);
  return polityName(p, Math.min(year ?? end - 1, end - 1 / 512));
}

/** 朝代的称呼:东方用国号的最后一个字("崇"),西幻用王室名 */
function dynName(civ: Civ, id: number, i: number): string {
  const p = civ.polities[id];
  const d = p.dynasties;
  const n = i === 0 || !d?.[i] ? p.name : d[i].name || p.name;
  if (!p.eastern) return n;
  const cs = [...n.replace(/^(大|后|南|北|东|西)(?=..)/, '')];
  return cs.length <= 2 ? cs.join('') : cs[cs.length - 1];
}

/** 王室兴起的城那半句:第一朝 = 立国时的国都 */
function seatText(civ: Civ, e: FlagEra, house: string): string {
  const city = civ.settlements[e.why.city]?.name ?? '';
  const where = `一座${SEAT_WORD[e.why.seat]}`;
  return e.dyn === 0 ? `立国于${city}，${where}` : `${house}兴起于${city}，${where}`;
}

/** 旗上每样东西的意思(一行一样) */
export function flagRows(civ: Civ, book: FlagBook, id: number, e: FlagEra): FlagRow[] {
  const p = civ.polities[id];
  if (!p) return [];
  const s = e.spec;
  if (e.how === 'edited') return editedRows(s);
  const w = e.why;
  const cu = civ.cultures[p.culture]?.name ?? '';
  const derived = e.how === 'derived';
  const parentName = w.parent !== undefined ? nameAt(civ, w.parent, p.founded) : '';

  if (w.restores !== undefined && e.dyn === 0) {
    const old = book.eras[w.restores];
    const last = old?.[old.length - 1];
    const rows: FlagRow[] = [{ k: '复国', v: `用回${nameAt(civ, w.restores)}亡国前的那面旗` }];
    return last ? rows.concat(flagRows(civ, book, w.restores, last)) : rows;
  }

  if (isEastern(s)) {
    const rows: FlagRow[] = [];
    const de = deOf(s.c[0]);
    let base = de >= 0 ? `${tName(s.c[0])}，${DE[de]}德` : colorWord(s.c[0]);
    const prev = book.eras[id]?.[e.dyn - 1];
    const pde = prev ? deOf(prev.spec.c[0]) : -1;
    if (e.dyn > 0 && de >= 0 && pde >= 0 && pde !== de) base += `（上一朝「${dynName(civ, id, e.dyn - 1)}」是${DE[pde]}德，${DE[pde]}生${DE[de]}）`;
    else if (e.dyn === 0 && parentName) base += `（沿用${parentName}的德）`;
    rows.push({ k: '底色', v: base, sw: [s.c[0]] });
    if (s.mark) {
      const v = w.inheritMark && e.dyn === 0 ? `沿用${parentName}的${MARK_NAME[s.mark]}` : `${seatText(civ, e, `${dynName(civ, id, e.dyn)}王室`)}；${MARK_NOTE[s.mark]}`;
      rows.push({ k: MARK_NAME[s.mark], v });
    }
    if (s.trim) {
      const from = p.parent !== undefined ? nameAt(civ, p.parent, p.founded) : '';
      rows.push({ k: '镶边', v: `${from ? `从${from}分出，` : ''}加一道${tName(s.trim)}边（像清代八旗的“正黄”“镶黄”）` });
    } else if (s.shape === 'banner' && s.edge) rows.push({ k: '犬牙边', v: `${colorWord(s.edge)}，古代军旗、将旗的锯齿边` });
    return rows;
  }

  if (s.charge?.sym === 'tamga') {
    const rows: FlagRow[] = [];
    if (s.shape === 'swallow') rows.push({ k: '燕尾旗', v: p.lineage === 'khanate' ? '草原上的汗国用燕尾旗' : '游牧的国家用燕尾旗' });
    rows.push({ k: '颜色', v: `${joinNames(s.c)}，${derived ? '照你改过的那面旗' : `${cu}人的颜色`}`, sw: uniq(s.c).slice(0, 3) });
    let v: string;
    if (e.dyn > 0) v = `${dynName(civ, id, e.dyn)}部掌权，换成他们的记号`;
    else if (w.nomadParent) v = `${parentName}的烙印加一笔（从它分出来）`;
    else v = `${cu}人王族的记号（草原部族给牲口烙的记号）`;
    rows.push({ k: '烙印', v });
    return rows;
  }

  // 西幻王国 / 共和国
  const rows: FlagRow[] = [];
  const split = p.parent !== undefined && !!s.mullets;
  const from = split ? nameAt(civ, p.parent!, p.founded) : '';
  let colors: string;
  if (derived) colors = `${joinNames(s.c)}，照你改过的那面旗`;
  else if (split && e.dyn === 0 && w.swap && w.swap[0] !== w.swap[1]) colors = `${joinNames(s.c)}，沿用${from}的旗色，${tName(w.swap[0])}换成${cu}人的${tName(w.swap[1])}`;
  else if (split) colors = `${joinNames(s.c)}，沿用${from}的旗色`;
  else colors = `${joinNames(s.c)}，${cu}人的颜色（同族的国家都从这几色里取）`;
  rows.push({ k: '颜色', v: colors, sw: uniq(s.c).slice(0, 3) });
  let layout: string;
  if (derived) layout = '照你改过的那面旗';
  else if (split) layout = `沿用${from}的样式`;
  else layout = p.lineage === 'republic' ? '共和国常用条纹、竖条、十字' : `${cu}人的国家常用的样式`;
  rows.push({ k: LAYOUT_NAME[s.layout], v: layout });
  if (s.mullet && s.mullets) {
    const v = w.nth && e.dyn === 0 ? `从${from}分出的第 ${w.nth} 个国家，加${NUM[s.mullets]}颗星` : `从${from}分出时加的`;
    rows.push({ k: '左上角的星', v });
  }
  if (s.charge) {
    const v = split && e.dyn === 0 ? `沿用${from}的图案` : seatText(civ, e, `${dynName(civ, id, e.dyn)}王室`);
    rows.push({ k: SYM_NAME[s.charge.sym], v });
  }
  return rows;
}

/** 作者改过的这一面:只说画的是什么 */
function editedRows(s: FlagSpec): FlagRow[] {
  if (isEastern(s)) {
    const de = deOf(s.c[0]);
    const rows: FlagRow[] = [{ k: '底色', v: de >= 0 ? `${tName(s.c[0])}，${DE[de]}德` : colorWord(s.c[0]), sw: [s.c[0]] }];
    if (s.mark) rows.push({ k: MARK_NAME[s.mark], v: `${colorWord(s.edge!)}，${MARK_NOTE[s.mark]}` });
    if (s.shape === 'banner') rows.push({ k: '犬牙边', v: `${colorWord(s.edge!)}，古代军旗、将旗的锯齿边` });
    if (s.trim) rows.push({ k: '镶边', v: `${colorWord(s.trim)}（像清代八旗的“镶黄”）` });
    return rows;
  }
  const rows: FlagRow[] = [{ k: '颜色', v: joinNames(s.c), sw: uniq(s.c).slice(0, 3) }];
  rows.push({ k: LAYOUT_NAME[s.layout], v: s.shape === 'swallow' ? '燕尾旗' : '你选的样式' });
  if (s.mullet && s.mullets) rows.push({ k: '左上角的星', v: `${NUM[s.mullets]}颗，${colorWord(s.mullet)}` });
  if (s.charge) rows.push({ k: SYM_NAME[s.charge.sym], v: `${colorWord(s.charge.t)}，你选的图案` });
  return rows;
}

/** 底下那句:这面旗怎么来的 */
export function flagNote(e: FlagEra): string {
  if (e.how === 'edited') return '你改过这面旗，之后的朝代照它往下配。';
  if (e.how === 'derived') return '照你改过的那面旗往下配的。';
  if (isEastern(e.spec)) return '按这一国的历史自动配的：换朝代时，按五德相生换底色，中间换成新王室兴起那座城的神兽或纹样。';
  if (e.spec.charge?.sym === 'tamga') return '按这一国的历史自动配的：换一家部族掌权时换烙印，颜色和样式不变。';
  return '按这一国的历史自动配的：换王室时换图案，颜色和样式不变。';
}
