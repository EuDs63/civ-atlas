/**
 * 信仰图层:地图按各州信的教上色(色块画法和民族色块一样,见 territory.ts,只是浓一点),留国界、国名。
 *
 * - 色块:把信仰换进"民族"那一层(faithCiv)再画 —— 罩染、晕边、按界线判归属、刚改信的州慢慢洇开,都沿用民族色块那一套。
 * - 选中一种信仰(宗教卡片开着)时,别的信仰变淡(faithColors):大教和它的教派保持原色。
 * - 圣城:城镇符号右上方一个这个教颜色的小圆点(白边),画在文字层上(drawHolyDots)。
 */
import type { Civ, Culture, Year } from '../../gen/civ/types';
import { Layer } from '../../gen/civ/types';
import { faithAt, faithRoot, shade } from '../../gen/civ/religion';

/** 选中别的信仰时,民间信仰变成的颜色;大教 / 教派往白里调这么多 */
const FADED_FOLK: [number, number, number] = [226, 221, 210];
const FADED = 0.62;

const views = new WeakMap<Civ, Civ>();
const bases = new WeakMap<Civ, Civ>();

/**
 * 把信仰换进"民族"那一层的 Civ(只给画色块用):民族列表换成信仰列表(颜色 = 信仰的颜色),
 * 日志和检查点里民族那一层换成各州的信仰;国家那一层、州、城一样不变。按 civ 缓存
 */
export function faithCiv(civ: Civ): Civ {
  const hit = views.get(civ);
  if (hit) return hit;
  const rel = civ.religion!;
  const L = civ.log;
  const F = rel.log;
  // 两本日志都按年份排好:国家那一层的条目和信仰的条目按年份并成一本(同一年国家的在前)
  let n = 0;
  for (let i = 0; i < L.size; i++) if (L.layer[i] !== Layer.Culture) n++;
  const size = n + F.size;
  const log = {
    size,
    year: new Float32Array(size),
    region: new Int32Array(size),
    layer: new Uint8Array(size),
    value: new Int16Array(size),
    cause: new Uint8Array(size),
  };
  let i = 0;
  let j = 0;
  for (let k = 0; k < size; k++) {
    while (i < L.size && L.layer[i] === Layer.Culture) i++;
    if (i < L.size && (j >= F.size || L.year[i] <= F.year[j])) {
      log.year[k] = L.year[i];
      log.region[k] = L.region[i];
      log.layer[k] = L.layer[i];
      log.value[k] = L.value[i];
      i++;
    } else {
      log.year[k] = F.year[j];
      log.region[k] = F.region[j];
      log.layer[k] = Layer.Culture;
      log.value[k] = F.value[j];
      j++;
    }
  }
  const checkpoints = civ.checkpoints.map((cp) => ({ year: cp.year, culture: faithAt(civ, cp.year), polity: cp.polity }));
  const base = civ.cultures[0];
  const cultures = rel.faiths.map((f): Culture => ({ ...base, id: f.id, name: f.name, color: f.color }));
  const view: Civ = { ...civ, cultures, log, checkpoints, culture: faithAt(civ, civ.endYear) };
  views.set(civ, view);
  bases.set(view, civ);
  return view;
}

/** faithCiv 换出来的 Civ → 原来的 Civ(不是换出来的 = null) */
export function faithBase(view: Civ): Civ | null {
  return bases.get(view) ?? null;
}

/** 信仰的颜色(colors[编号 × 3 …]);focus = 选中的信仰:它(大教连同它的教派)以外的变淡 */
export function faithColors(civ: Civ, focus?: number | null): Uint8Array {
  const rel = civ.religion!;
  const out = new Uint8Array(Math.max(1, rel.faiths.length) * 3);
  const on = focus !== undefined && focus !== null && !!rel.faiths[focus];
  rel.faiths.forEach((f, i) => {
    const faded = on && i !== focus && faithRoot(rel, i) !== focus;
    out.set(faded ? (f.kind === 'folk' ? FADED_FOLK : shade(f.color, FADED)) : f.color, i * 3);
  });
  return out;
}

/** 某一年要画小圆点的圣城:[城的编号, 颜色];focus = 选中的信仰(只画它所属大教的圣城) */
export function holyCities(civ: Civ, year: Year, focus?: number | null): { settlement: number; color: [number, number, number] }[] {
  const rel = civ.religion;
  if (!rel) return [];
  const only = focus !== undefined && focus !== null && rel.faiths[focus] ? (rel.faiths[focus].kind === 'folk' ? -2 : faithRoot(rel, focus)) : -1;
  const out: { settlement: number; color: [number, number, number] }[] = [];
  for (const f of rel.faiths) {
    if (f.kind !== 'great' || f.holy === undefined || (f.founded ?? 0) > year) continue;
    if (only !== -1 && f.id !== only) continue;
    const s = civ.settlements[f.holy];
    if (!s || s.founded > year || (s.ended !== undefined && s.ended <= year)) continue;
    out.push({ settlement: s.id, color: f.color });
  }
  return out;
}

/**
 * 圣城的小圆点(文字层,画布像素):城镇符号右上方(at = 城在画布上的位置,往右上偏 9 个屏幕像素),
 * 直径 11 个屏幕像素(含 2 像素白边),带一点阴影
 */
export function drawHolyDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: readonly number[], dpr: number): void {
  const cx = x + 9 * dpr;
  const cy = y - 9 * dpr;
  const r = 5.5 * dpr;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 2 * dpr;
  ctx.shadowOffsetY = 1 * dpr;
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 0.5 * dpr;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 0.25 * dpr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 2 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${color.join(',')})`;
  ctx.fill();
  ctx.restore();
}
