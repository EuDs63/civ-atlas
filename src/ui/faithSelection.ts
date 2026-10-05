/**
 * 选中一种信仰(宗教卡片开着)时地图上怎么画:
 *   - 选中的样子画在它的城上:大教 = 圣城,教派 = 分出时那国的国都(外面一圈细环 + 名字底下的光晕,和选中一座城一样);民间信仰不画
 *   - 信仰图层上别的信仰变淡(faithFocus,见 render/civ/faith.ts 的 faithColors)
 */
import type { Civ } from '../gen/civ/types';
import type { SelectionTarget } from '../render/civ/highlight';
import type { MapSelection } from './civView';

/** 地图上画选中用的目标(信仰换成它的城;其余照旧) */
export function selectionOnMap(civ: Civ | null, sel: MapSelection | null): SelectionTarget | null {
  if (!sel || sel.kind !== 'faith') return sel;
  const f = civ?.religion?.faiths[sel.id];
  const city = f?.kind === 'great' ? f.holy : f?.kind === 'sect' ? f.seat : undefined;
  return city !== undefined && civ?.settlements[city] ? { kind: 'settlement', id: city } : null;
}

/** 选中的信仰(没选信仰 = null) */
export function faithFocusOf(sel: MapSelection | null): number | null {
  return sel?.kind === 'faith' ? sel.id : null;
}
