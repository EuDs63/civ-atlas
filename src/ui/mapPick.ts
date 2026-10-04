/**
 * 点选(阶段 4)· 文字层上点到了什么:CivLayer 每次排完地图文字就把结果(放上去的城镇符号、每个字的位置)记在这里,
 * App 单击地图时按屏幕坐标查 —— 城镇符号、城名、国名、地名(海、山、河、湖、岛、荒漠)。
 * 都没点到时 App 再按地块查国土 / 州。
 */
import { placedMarkBox, type LabelView, type Placement } from '../render/labels/draw';
import { glyphBox } from '../render/labels/layout';

export interface LabelPick {
  kind: 'polity' | 'settlement' | 'place';
  id: number;
}

interface Snapshot {
  canvas: HTMLCanvasElement;
  placed: Placement;
  view: LabelView;
}

let last: Snapshot | null = null;

/** CivLayer 排完文字调(没画字时传 null) */
export function setMapPlacement(s: Snapshot | null) {
  last = s;
}

/** 点到符号 / 字的容差(屏幕像素):小符号、细字也好点 */
const SLOP = 4;
/** 城镇符号的点选框至少这么大(屏幕像素,见方) */
const MIN_MARK = 14;

/**
 * 屏幕坐标(clientX / clientY)→ 点到的城镇符号、城名、国名、地名;没点到 = null。
 * 几样都点到时取离字 / 符号中心最近的(文字和符号互相避让,很少重叠)
 */
export function pickLabelAt(clientX: number, clientY: number): LabelPick | null {
  if (!last || !last.canvas.isConnected) return null;
  const { canvas, placed } = last;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height || !canvas.width) return null;
  /** 画布像素 / 屏幕像素 */
  const f = canvas.width / r.width;
  const x = (clientX - r.left) * f;
  const y = (clientY - r.top) * f;
  if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return null;
  let best: LabelPick | null = null;
  let bestD = Infinity;
  const consider = (pick: LabelPick, b: [number, number, number, number]) => {
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return;
    const d = Math.hypot(x - (b[0] + b[2]) / 2, y - (b[1] + b[3]) / 2);
    if (d < bestD) {
      bestD = d;
      best = pick;
    }
  };
  for (const m of placed.marks) {
    const b = placedMarkBox(m);
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const hw = Math.max((b[2] - b[0]) / 2 + SLOP * f, (MIN_MARK / 2) * f);
    const hh = Math.max((b[3] - b[1]) / 2 + SLOP * f, (MIN_MARK / 2) * f);
    consider({ kind: 'settlement', id: m.mark.id }, [cx - hw, cy - hh, cx + hw, cy + hh]);
  }
  for (const l of placed.labels) {
    const pk = l.item.pick;
    if (!pk || l.alpha < 0.3) continue;
    for (const g of l.glyphs) consider(pk, glyphBox(g, l.px, SLOP * f));
  }
  return best;
}

/**
 * 冒烟检查用:文字层上现在能点的东西(城镇符号 + 文字),屏幕坐标。
 * window.__wfPickables() 返回 [{ kind, id, text, x, y }](符号的 text 为空)
 */
export function pickables(): { kind: string; id: number; text: string; x: number; y: number }[] {
  if (!last || !last.canvas.isConnected) return [];
  const { canvas, placed } = last;
  const r = canvas.getBoundingClientRect();
  const f = r.width / canvas.width;
  const out: { kind: string; id: number; text: string; x: number; y: number }[] = [];
  for (const m of placed.marks) {
    const b = placedMarkBox(m);
    out.push({ kind: 'mark', id: m.mark.id, text: '', x: r.left + ((b[0] + b[2]) / 2) * f, y: r.top + ((b[1] + b[3]) / 2) * f });
  }
  for (const l of placed.labels) {
    const pk = l.item.pick;
    if (!pk || !l.glyphs.length) continue;
    const g = l.glyphs[Math.floor(l.glyphs.length / 2)];
    out.push({ kind: pk.kind, id: pk.id, text: l.item.text, x: r.left + g.x * f, y: r.top + g.y * f });
  }
  return out;
}

if (typeof window !== 'undefined') (window as unknown as { __wfPickables: typeof pickables }).__wfPickables = pickables;
