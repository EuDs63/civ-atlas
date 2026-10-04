/**
 * 城镇符号和城名的排法:按缩放逐级出现,城名在符号旁 8 个方位里挑一个不压字的位置。
 *
 * 真正的避让在 draw.ts 的 placeMap 里统一做(文字、符号按 priority 混排贪心放,网格分桶查重叠);
 * 这里定"谁先放、放大到几倍才出现、名字往哪几个方位试":
 *
 *   | 级别 | 符号从几倍出现 | 名字从几倍出现 | 名字字号(CSS 像素) |
 *   |------|----------------|----------------|----------------------|
 *   | 国都 | 1(总画)      | 1              | 13.5,加粗           |
 *   | 大城 | 1              | 1.3            | 12                   |
 *   | 城   | 1              | 2              | 11.5                 |
 *   | 镇   | 1.9            | 3.2            | 10.5                 |
 *   | 村   | 3.4            | 6              | 10.5                 |
 *
 * 优先级(越大越先放;地名见 civ/labels.ts:大洋 100–109、大山脉 92–101、海 88–97……,国名 101–106):
 *   国都符号总画 → 国名 → 国都名 100.5 → 大城、城的符号 100 → 大城名 89 → 城名 70 → 镇的符号、名 60 / 45 → 村 30 / 20;
 *   名字还没到出现门槛的镇、村符号排在所有文字之后放,和字挤在一起就不画,放大后再出现。
 * 国名先于城的符号放:国名的大字底下压着的小城先不画,放大后国名相对变小、让出位置,城就出来了。
 * 国都比国名先放(国名总会让开国都:国名有上百个候选位置,前后左右挪、小一两档);
 * 国都名紧跟在国名后面放,8 个方位之外再多试一圈远一点的位置;国名挑位置时也会给自家国都名留好地方(keepRoomFor)。
 */
import type { Candidate, Glyph } from './layout';
import { markBox, type LabelItem, type LabelMark, type LabelView } from './draw';

/** 符号从几倍出现(按级别:村、镇、城、大城、国都) */
export const SYMBOL_MIN_ZOOM = [3.4, 1.9, 1, 1, 1];
/** 名字从几倍出现 */
export const NAME_MIN_ZOOM = [6, 3.2, 2, 1.3, 1];
/** 名字字号(CSS 像素,参照宽度、缩放 1 倍) */
export const NAME_SIZE = [10.5, 10.5, 11.5, 12, 13.5];
/** 名字放大时字号跟着长的幂 */
export const NAME_GROW = 0.3;
/** 符号的优先级(名字已经可以出现时;镇、村的名字还没出现时符号排在所有文字之后,见 LabelMark.softBelow);名字的优先级 */
export const SYMBOL_PRIORITY = [30, 60, 100, 100, Infinity];
export const NAME_PRIORITY = [20, 45, 70, 89, 100.5];

/**
 * 城名在符号旁的 8 个候选位置(画布像素),顺序:右、左、上、下、右上、右下、左上、左下。
 * box = 符号的外接框;字横排,字距 tracking 个字宽。
 */
export function aroundMark(text: string, box: [number, number, number, number], px: number, tracking: number, dpr: number, rings = 1): Candidate[] {
  const cs = [...text];
  const n = cs.length;
  if (!n) return [];
  const pitch = px * (1 + tracking);
  const w = pitch * (n - 1) + px;
  const g = Math.max(2 * dpr, px * 0.22);
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const row = (x: number, y: number): Candidate => ({
    on: 0,
    glyphs: cs.map((ch, i): Glyph => ({ ch, x: x - w / 2 + px / 2 + i * pitch, y, a: 0 })),
  });
  const out: Candidate[] = [];
  for (let ring = 0; ring < rings; ring++) {
    // 第二圈:离符号再远大半个字,左右两侧再上下错开半行
    const e = ring * px * 0.7;
    // 斜角上的字往符号的角里收一点(不压符号的框)
    const t = ring ? 0 : g * 0.9;
    out.push(
      row(x1 + g + e + w / 2, cy),
      row(x0 - g - e - w / 2, cy),
      row(cx, y0 - g - e - px / 2),
      row(cx, y1 + g + e + px / 2),
      row(x1 + g + e + w / 2 - t, y0 - g - e - px / 2 + t),
      row(x1 + g + e + w / 2 - t, y1 + g + e + px / 2 - t),
      row(x0 - g - e - w / 2 + t, y0 - g - e - px / 2 + t),
      row(x0 - g - e - w / 2 + t, y1 + g + e + px / 2 - t),
    );
    if (ring) out.push(row(x1 + g + w / 2, cy - px * 0.6), row(x1 + g + w / 2, cy + px * 0.6), row(x0 - g - w / 2, cy - px * 0.6), row(x0 - g - w / 2, cy + px * 0.6));
  }
  return out;
}

/** 城名标注:围着自家符号(mark)的 8 个方位 */
export function settlementNameItem(base: Omit<LabelItem, 'place' | 'mark' | 'layout' | 'path'>, mark: LabelMark, tracking = 0.04, rings = 1): LabelItem {
  return {
    ...base,
    layout: 'point',
    path: [mark.x, mark.y],
    mark: mark.id,
    // 城名挨着别的字没关系(字号、颜色都和别的字不同),留一点白就行
    space: 0.3,
    place: (px: number, view: LabelView) => aroundMark(base.text, markBox(mark, view), px, tracking, view.dpr, rings),
  };
}
