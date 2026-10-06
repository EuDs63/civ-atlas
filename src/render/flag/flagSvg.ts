/**
 * 把一面旗(gen/civ/flags.ts 的 FlagSpec)画成 SVG 字符串:国家卡片、列表里的小旗,旗帜详情的大图,地图上国都城堡插的旗都用它。
 * 旗面是 300 × 200 的格子(3 : 2);图案、纹样、神兽在 100 × 100 的格子里画,再缩放到位置。
 *
 * 小尺寸简化:显示宽度不到 60 像素时牙旗的犬牙变少变大,不到 30 像素时纹样画大一点(朝代表、首屏列表那么小)。
 * 外面那圈 0.5 像素的淡边由界面的 CSS 加(燕尾旗的缺口 CSS 描不出来,燕尾旗在 SVG 里描)。
 */
import { TINCT, underCharge, type FlagSpec, type Mark, type Shape, type Sym, type Tinct } from '../../gen/civ/flags';
import { markSvg } from './marks';

const W = 300;
const H = 200;
const hex = (t: Tinct) => TINCT[t].hex;

let uid = 0;

export interface FlagSvgOpts {
  /** 显示宽度(CSS 像素):小于 60、30 时画得简单些。不给 = 按大图画 */
  display?: number;
  /** 描一圈淡边(燕尾旗总是描) */
  outline?: boolean;
  /** 像素宽(给 <img> / 画布用);不给 = 不写宽高,由 CSS 定 */
  px?: number;
}

/** 一面旗的 SVG */
export function flagSvg(spec: FlagSpec, opts: FlagSvgOpts = {}): string {
  const dw = opts.display ?? 300;
  const detail = dw < 30 ? 2 : dw < 60 ? 1 : 0;
  const body = layoutSvg(spec) + mulletsSvg(spec) + chargeSvg(spec) + easternSvg(spec, detail);
  const size = opts.px ? ` width="${opts.px}" height="${Math.round((opts.px * H) / W)}"` : '';
  const sw = Math.max(1.5, (1.2 * W) / dw);
  if (spec.shape === 'swallow') {
    const id = `fl${uid++}`;
    const clip = shapePath(spec.shape);
    const outline = `<path d="${clip}" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="${sw.toFixed(1)}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${size}><defs><clipPath id="${id}"><path d="${clip}"/></clipPath></defs><g clip-path="url(#${id})">${body}${outline}</g></svg>`;
  }
  const outline = opts.outline ? `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="${sw.toFixed(1)}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${size}>${body}${outline}</svg>`;
}

/** 旗的外轮廓(旗面格子里的路径;画布上描边也用它) */
export function shapePath(shape: Shape): string {
  if (shape === 'swallow') return `M0 0H${W}L${W - 70} ${H / 2}L${W} ${H}H0Z`;
  return `M0 0H${W}V${H}H0Z`;
}

/** 燕尾旗缺口的深度(占旗宽的比例;画布上描边用) */
export const SWALLOW_CUT = 70 / W;

function mulletsSvg(s: FlagSpec): string {
  if (!s.mullet) return '';
  let out = '';
  for (let i = 0; i < (s.mullets ?? 1); i++) out += symbolSvg('star', s.mullet, 26 + i * 24, 26, 22);
  return out;
}

const rect = (x: number, y: number, w: number, h: number, t: Tinct) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${hex(t)}"/>`;

function layoutSvg(s: FlagSpec): string {
  const [a, b = a, c = b] = s.c;
  switch (s.layout) {
    case 'plain':
      return rect(0, 0, W, H, a);
    case 'bi-h':
      return rect(0, 0, W, H / 2, a) + rect(0, H / 2, W, H / 2, b);
    case 'bi-v':
      return rect(0, 0, W / 2, H, a) + rect(W / 2, 0, W / 2, H, b);
    case 'tri-h':
      return rect(0, 0, W, H / 3 + 0.5, a) + rect(0, H / 3, W, H / 3 + 0.5, b) + rect(0, (2 * H) / 3, W, H / 3, c);
    case 'tri-v':
      return rect(0, 0, W / 3 + 0.5, H, a) + rect(W / 3, 0, W / 3 + 0.5, H, b) + rect((2 * W) / 3, 0, W / 3, H, c);
    case 'fess':
      return rect(0, 0, W, H, a) + rect(0, H / 4, W, H / 2, b);
    case 'pale':
      return rect(0, 0, W, H, a) + rect(W / 4, 0, W / 2, H, b);
    case 'nordic': {
      // 偏十字;有第三色时十字外面再包一圈(像挪威)
      const edge = c !== b ? rect(78, 0, 56, H, c === a ? b : c) + rect(0, 72, W, 56, c === a ? b : c) : '';
      return rect(0, 0, W, H, a) + edge + rect(88, 0, 36, H, b) + rect(0, 82, W, 36, b);
    }
    case 'cross':
      return rect(0, 0, W, H, a) + rect(W / 2 - 20, 0, 40, H, b) + rect(0, H / 2 - 20, W, 40, b);
    case 'saltire':
      return rect(0, 0, W, H, a) + `<path d="M0 0L${W} ${H}M${W} 0L0 ${H}" stroke="${hex(b)}" stroke-width="40"/>`;
    case 'per-bend':
      return rect(0, 0, W, H, a) + `<path d="M0 ${H}L${W} 0V${H}Z" fill="${hex(b)}"/>`;
    case 'chevron':
      return rect(0, 0, W, H / 2, a) + rect(0, H / 2, W, H / 2, b) + `<path d="M0 0L130 ${H / 2}L0 ${H}Z" fill="${hex(c)}"/>`;
    case 'canton':
      return rect(0, 0, W, H, a) + rect(0, 0, 130, 100, b);
    case 'stripes': {
      let out = '';
      const n = 9;
      for (let i = 0; i < n; i++) out += rect(0, (i * H) / n, W, H / n + 0.5, i % 2 ? b : a);
      return out + rect(0, 0, 120, (5 * H) / n, c);
    }
    case 'bordure':
      return rect(0, 0, W, H, b) + rect(18, 18, W - 36, H - 36, a);
    case 'quarterly':
      return rect(0, 0, W / 2, H / 2, a) + rect(W / 2, 0, W / 2, H / 2, b) + rect(0, H / 2, W / 2, H / 2, b) + rect(W / 2, H / 2, W / 2, H / 2, a);
    case 'disc':
      return rect(0, 0, W, H, a) + `<circle cx="${W / 2}" cy="${H / 2}" r="64" fill="${hex(b)}"/>`;
    case 'wavy': {
      const wave = (y: number) => {
        let d = `M-10 ${y}`;
        for (let x = -10; x < W + 40; x += 50) d += ` q12.5 -14 25 0 t25 0`;
        return d;
      };
      return rect(0, 0, W, H, a) + [118, 150, 182].map((y) => `<path d="${wave(y)}" fill="none" stroke="${hex(b)}" stroke-width="13"/>`).join('');
    }
    case 'hoist':
      return rect(0, 0, W, H, a) + rect(0, 0, 70, H, b);
  }
}

function chargeSvg(s: FlagSpec): string {
  const ch = s.charge;
  if (!ch) return '';
  let cx = W / 2;
  let cy = H / 2;
  let size = 110;
  const L = s.layout;
  if (ch.at === 'canton') {
    if (L === 'stripes') [cx, cy, size] = [60, 55, 70];
    else if (L === 'nordic') [cx, cy, size] = [44, 41, 54];
    else if (L === 'cross') [cx, cy, size] = [65, 40, 58];
    else if (L === 'quarterly') [cx, cy, size] = [75, 50, 72];
    else if (L === 'per-bend') [cx, cy, size] = [82, 62, 82];
    else if (L === 'wavy') [cx, cy, size] = [150, 56, 76];
    else [cx, cy, size] = [65, 50, 72];
  } else if (ch.at === 'hoist') {
    if (L === 'chevron') [cx, cy, size] = [44, 100, 58];
    else if (L === 'bi-v') [cx, cy, size] = [75, 100, 100];
    else if (L === 'fess') [cx, cy, size] = [100, 100, 84];
    else if (s.shape === 'swallow') [cx, cy, size] = [105, 100, 112];
    else [cx, cy, size] = [90, 100, 100];
  } else {
    if (L === 'pale') size = 108;
    if (L === 'disc') size = 92;
    if (L === 'hoist') [cx, size] = [170, 112];
    if (L === 'tri-h') size = 66;
    if (L === 'bi-h') size = 96;
    if (L === 'tri-v') size = 62;
    if (L === 'saltire') size = 90;
  }
  return symbolSvg(ch.sym, ch.t, cx, cy, size, ch.tamga, hex(underCharge(s, ch.at)));
}

/** 东方旗:犬牙边(牙旗)、镶边,中间一只神兽或一样纹样(和犬牙边同色) */
function easternSvg(s: FlagSpec, detail: number): string {
  if (!s.edge) return '';
  const e = hex(s.edge);
  const f = hex(s.c[0]);
  const small = detail === 2;
  if (s.shape !== 'banner') {
    // 东方的方旗 / 燕尾旗:不带犬牙
    const cx = s.shape === 'swallow' ? (W - 70) / 2 + 6 : W / 2;
    const band = s.trim ? `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${hex(s.trim)}" stroke-width="16"/>` : '';
    return band + (s.mark ? markSvg(s.mark, e, f, cx, H / 2, small ? 150 : 132) : '');
  }
  const t = [22, 28, 34][detail]; // 牙的深度
  let d = '';
  // 上、下两条边
  const n = [10, 6, 4][detail];
  const step = (W - t) / n;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    d += `M${x} 0L${x + step} 0L${x + step / 2} ${t}Z`;
    d += `M${x} ${H}L${x + step} ${H}L${x + step / 2} ${H - t}Z`;
  }
  // 旗尾一条边
  const m = [7, 4, 3][detail];
  const vs = H / m;
  for (let i = 0; i < m; i++) {
    const y = i * vs;
    d += `M${W} ${y}L${W} ${y + vs}L${W - t} ${y + vs / 2}Z`;
  }
  const band = s.trim ? `<path d="M0 ${t}H${W - t}V${H - t}H0" fill="none" stroke="${hex(s.trim)}" stroke-width="16"/>` : '';
  const mark = s.mark ? markSvg(s.mark, e, f, (W - t) / 2, H / 2, small ? 150 : 132) : '';
  return `<path d="${d}" fill="${e}"/>${band}${mark}`;
}

// ---------------------------------------------------------------------------
// 西幻、汗国的图案:100 × 100 的格子,col = 图案色,u = 底色(叶脉、鱼眼这些"抠出来"的地方)

function symbolSvg(sym: Sym, t: Tinct, cx: number, cy: number, size: number, tamga = 0, under = '#fff'): string {
  const k = size / 100;
  const col = hex(t);
  return `<g transform="translate(${cx - 50 * k} ${cy - 50 * k}) scale(${k})" fill="${col}" stroke="${col}">${SYMBOL[sym](under, tamga)}</g>`;
}

function starPts(n: number, r1: number, r2: number, cx = 50, cy = 50, rot = -Math.PI / 2): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = rot + (i * Math.PI) / n;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

const NS = 'stroke="none"';

const SYMBOL: Record<Sym, (u: string, tamga: number) => string> = {
  star: () => `<polygon ${NS} points="${starPts(5, 42, 17)}"/>`,
  star8: () => `<polygon ${NS} points="${starPts(8, 44, 20)}"/>`,
  sun: () => `<polygon ${NS} points="${starPts(12, 46, 26)}"/><circle ${NS} cx="50" cy="50" r="22"/>`,
  crescent: () => `<path ${NS} fill-rule="evenodd" d="M50 14A36 36 0 1 0 50 86A36 36 0 1 0 50 14ZM62 20A30 30 0 1 1 62 80A30 30 0 1 1 62 20Z"/>`,
  tower: () => `<path ${NS} fill-rule="evenodd" d="M28 88V42H24V22H33V30H42V22H58V30H67V22H76V42H72V88ZM43 88V72A7 7 0 0 1 57 72V88ZM46 48H54V60H46Z"/>`,
  crown: () =>
    `<path ${NS} d="M24 70L18 32L36 50L50 24L64 50L82 32L76 70Z"/><rect ${NS} x="24" y="73" width="52" height="10"/><circle ${NS} cx="18" cy="30" r="5"/><circle ${NS} cx="50" cy="21" r="5"/><circle ${NS} cx="82" cy="30" r="5"/>`,
  mountain: (u) => `<path ${NS} d="M6 84L36 34L50 54L64 22L94 84Z"/><path stroke="none" fill="${u}" d="M58 32L64 22L70 32L66 36L62 31Z"/>`,
  ship: () => `<path ${NS} d="M14 64H86L74 82H26Z"/><rect ${NS} x="47.5" y="10" width="5" height="56"/><path ${NS} d="M27 22H73Q67 39 73 56H27Q33 39 27 22Z"/><path ${NS} d="M52 10L68 14L52 18Z"/>`,
  anchor: () =>
    `<g fill="none" stroke-width="7" stroke-linecap="round"><circle cx="50" cy="17" r="8"/><path d="M50 25V86M34 36H66M20 62Q24 86 50 86Q76 86 80 62"/></g><path ${NS} d="M12 66L20 52L28 66Z"/><path ${NS} d="M72 66L80 52L88 66Z"/>`,
  trident: () =>
    `<g fill="none" stroke-width="7" stroke-linecap="round"><path d="M50 18V92M28 22V40Q28 54 50 54Q72 54 72 40V22"/></g><path ${NS} d="M50 6L58 20H42Z"/><path ${NS} d="M28 10L35 24H21Z"/><path ${NS} d="M72 10L79 24H65Z"/>`,
  tree: () => `<path ${NS} d="M50 8L68 36H59L75 58H63L80 82H20L37 58H25L41 36H32Z"/><rect ${NS} x="45" y="80" width="10" height="12"/>`,
  leaf: (u) => `<path ${NS} d="M50 6Q86 40 50 92Q14 40 50 6Z"/><path fill="none" stroke="${u}" stroke-width="3" d="M50 22V84M50 44L38 34M50 44L62 34M50 62L36 50M50 62L64 50"/>`,
  rose: (u) => {
    let d = '';
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      d += `<circle ${NS} cx="${(50 + 22 * Math.cos(a)).toFixed(1)}" cy="${(50 + 22 * Math.sin(a)).toFixed(1)}" r="19"/>`;
    }
    return d + `<circle stroke="none" fill="${u}" cx="50" cy="50" r="12"/><circle ${NS} cx="50" cy="50" r="7"/>`;
  },
  key: () => `<g fill="none" stroke-width="8" stroke-linecap="round"><circle cx="50" cy="24" r="13"/><path d="M50 37V88M50 72H64M50 84H62"/></g>`,
  sword: () => `<path ${NS} d="M46 66V16L50 6L54 16V66Z"/><rect ${NS} x="30" y="64" width="40" height="7" rx="2"/><rect ${NS} x="46.5" y="71" width="7" height="15"/><circle ${NS} cx="50" cy="90" r="5"/>`,
  wheat: () => {
    let d = `<path fill="none" stroke-width="4" d="M50 94V20"/>`;
    for (let i = 0; i < 4; i++) {
      const y = 30 + i * 13;
      d += `<ellipse ${NS} cx="40" cy="${y}" rx="6" ry="11" transform="rotate(-32 40 ${y})"/><ellipse ${NS} cx="60" cy="${y}" rx="6" ry="11" transform="rotate(32 60 ${y})"/>`;
    }
    return d + `<ellipse ${NS} cx="50" cy="16" rx="6" ry="11"/>`;
  },
  fish: (u) => `<path ${NS} d="M12 50Q42 22 72 50Q42 78 12 50Z"/><path ${NS} d="M68 50L90 32V68Z"/><circle stroke="none" fill="${u}" cx="28" cy="46" r="4"/>`,
  bird: () => `<path ${NS} d="M6 44Q28 26 50 52Q72 26 94 44Q74 40 56 66L50 74L44 66Q26 40 6 44Z"/>`,
  bow: () =>
    `<g fill="none" stroke-linecap="round"><path stroke-width="7" d="M38 10Q80 50 38 90"/><path stroke-width="2.5" d="M38 10V90"/><path stroke-width="5" d="M14 50H82"/></g><path ${NS} d="M92 50L78 41V59Z"/>`,
  tamga: (_u, code) => tamgaSvg(code),
};

/** 烙印:主干 + 一两笔(草原部族给牲口烙的记号;分出去的部族在原记号上加一笔) */
function tamgaSvg(code: number): string {
  const base = code & 7;
  const mods = [(code >> 3) & 7, (code >> 6) & 7].filter(Boolean);
  const B = [
    'M24 22V54H76V22M50 54V90', // 梳子(Ш 下面一竖)
    'M24 18Q24 58 50 58Q76 58 76 18M50 58V90', // 弓口朝上 + 竖
    'M50 20m-15 0a15 15 0 1 0 30 0a15 15 0 1 0 -30 0M50 35V90', // 圈 + 竖
    'M24 88V50Q24 22 50 22Q76 22 76 50V88', // 拱门
    'M22 22Q50 66 78 22M50 44V90', // 新月 + 竖
    'M28 22H72M50 22V90M28 22V40M72 22V40', // 丁字带两脚
  ][base % 6];
  const M = [
    '',
    'M34 90H66', // 底下一横
    'M50 6m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0', // 顶上一点
    'M50 90Q68 90 70 76', // 尾巴勾
    'M34 72H66', // 下面一横
    'M36 90L50 76L64 90', // 两只脚
    'M24 56Q12 56 12 68M76 56Q88 56 88 68', // 两边小钩
  ];
  const d = [B, ...mods.map((m) => M[m] ?? '')].join(' ');
  return `<path fill="none" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`;
}

// ---------------------------------------------------------------------------
// 改旗时按钮上的小图:图案 / 神兽、纹样用文字颜色(currentColor),"抠出来"的地方用按钮底色(CSS 变量 --fl-u)

const U = '__U__';
const withUnder = (svg: string) => svg.replace(/fill="__U__"/g, 'style="fill:var(--fl-u)"').replace(/stroke="__U__"/g, 'style="stroke:var(--fl-u)"');

export function symbolButtonSvg(sym: Sym): string {
  return withUnder(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill="currentColor" stroke="currentColor">${SYMBOL[sym](U, 0o11)}</g></svg>`);
}

export function markButtonSvg(m: Mark): string {
  return withUnder(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markSvg(m, 'currentColor', U, 50, 50, 72)}</svg>`);
}
