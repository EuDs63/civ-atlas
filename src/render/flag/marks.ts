/**
 * 东方旗中间的纹样:都从古代旗帜、器物上用过的标志抽象出来(出处见 gen/civ/flags.ts 的 MARK_NOTE)。
 * 100 × 100 的格子里画;col = 纹样的颜色(外层 <g> 的 fill / stroke),u = 底色(钱的方孔、太极的阴面这些"抠出来"的地方)。
 * 神兽在 beasts.ts。
 */
import { isBeast, type Emblem, type Mark } from '../../gen/civ/flags';
import { beastSvg } from './beasts';

const NS = 'stroke="none"';

function starPts(n: number, r1: number, r2: number, cx: number, cy: number, rot = -Math.PI / 2): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = rot + (i * Math.PI) / n;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}
const star4 = (x: number, y: number, r = 9) => `<polygon ${NS} points="${starPts(4, r, r * 0.34, x, y)}"/>`;

const EMBLEM: Record<Emblem, (u: string) => string> = {
  // 日:实心圆(《周礼》"日月为常")
  ri: () => `<circle ${NS} cx="50" cy="50" r="34"/>`,
  // 日月:左日右月
  riyue: () => `<circle ${NS} cx="32" cy="50" r="20"/><path ${NS} d="M76 26A24 24 0 1 0 76 74A27 27 0 0 1 76 26Z"/>`,
  // 北斗七星,连成斗和斗柄(《礼记》"招摇在上")
  dou: () => {
    const p = [
      [8, 30],
      [24, 40],
      [38, 48],
      [52, 58],
      [56, 82],
      [84, 86],
      [88, 62],
    ];
    return `<path fill="none" stroke-width="2.5" d="M${p.map((q) => q.join(' ')).join('L')}L52 58"/>` + p.map(([x, y]) => star4(x, y, 10)).join('');
  },
  // 三星(参宿腰带,"三星在天")
  san: () => star4(22, 70, 15) + star4(50, 50, 15) + star4(78, 30, 15),
  // 雷纹(青铜器上的回字形)
  lei: () => `<path fill="none" stroke-width="8" stroke-linecap="square" d="M14 86V14H86V86H30V30H70V70H46V46H58"/>`,
  // 钱(圆钱方孔)
  qian: (u) => `<circle ${NS} cx="50" cy="50" r="40"/><rect stroke="none" fill="${u}" x="38" y="38" width="24" height="24"/><circle fill="none" stroke="${u}" stroke-width="3" cx="50" cy="50" r="33"/>`,
  // 菱(四个菱形拼成一个大菱形,汉代织锦)
  ling: () =>
    [
      [50, 27],
      [27, 50],
      [73, 50],
      [50, 73],
    ]
      .map(([x, y]) => `<path ${NS} d="M${x} ${y - 21}L${x + 21} ${y}L${x} ${y + 21}L${x - 21} ${y}Z"/>`)
      .join(''),
  // 水波纹(彩陶、铜镜上的水纹)
  shui: () => [30, 50, 70].map((y) => `<path fill="none" stroke-width="8" stroke-linecap="round" d="M10 ${y}Q20 ${y - 11} 30 ${y}T50 ${y}T70 ${y}T90 ${y}"/>`).join(''),
  // 太极(阴阳)
  taiji: (u) =>
    `<circle fill="${u}" stroke-width="4" cx="50" cy="50" r="40"/><path ${NS} d="M50 10A40 40 0 0 1 50 90A20 20 0 0 1 50 50A20 20 0 0 0 50 10Z"/><circle ${NS} cx="50" cy="30" r="6"/><circle stroke="none" fill="${u}" cx="50" cy="70" r="6"/>`,
  // 火:三簇火苗
  huo: () => {
    const f = (x: number, y: number, k: number) =>
      `<path ${NS} transform="translate(${x} ${y}) scale(${k})" d="M0 -46Q16 -24 14 -6Q12 12 0 14Q-12 12 -14 -6Q-16 -20 -4 -30Q-4 -16 2 -12Q6 -28 0 -46Z"/>`;
    return f(50, 70, 1.25) + f(22, 80, 0.7) + f(78, 80, 0.7);
  },
};

function emblemSvg(e: Emblem, col: string, under: string, cx: number, cy: number, size: number): string {
  const k = size / 100;
  return `<g transform="translate(${cx - 50 * k} ${cy - 50 * k}) scale(${k})" fill="${col}" stroke="${col}">${EMBLEM[e](under)}</g>`;
}

/** 旗中间的神兽或纹样:中心 (cx, cy)、纹样占 size × size;神兽是整只动物,格子大一些 */
export function markSvg(m: Mark, col: string, under: string, cx: number, cy: number, size: number): string {
  return isBeast(m) ? beastSvg(m, col, under, cx, cy, size * 1.4) : emblemSvg(m, col, under, cx, cy, size);
}
