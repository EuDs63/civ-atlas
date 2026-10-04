/**
 * 界面显示用的小工具:民族类型的中文名、族名、州名。
 * 单独放一个文件,不引入起名器和推演代码 —— 主线程(面板、悬停信息)只用得到这些,打包时不用把地名词库带上。
 */
import type { Civ, Culture, CultureKind } from './types';

/** 七种民族类型:中文名、扩张性基数(Azgaar)、一句话说明 */
export const KIND_INFO: Record<CultureKind, { name: string; expansionism: number; hint: string }> = {
  farm: { name: '农耕', expansionism: 1, hint: '哪里都能种地,不偏不倚' },
  nomad: { name: '游牧', expansionism: 1.5, hint: '草原荒漠上来去如风,进森林很慢,几乎不渡海' },
  sea: { name: '海洋', expansionism: 1.5, hint: '沿海岸扩张,能跨海峡、走远洋航线,不爱深入内陆' },
  highland: { name: '高原', expansionism: 1.2, hint: '在高原山地如履平地,很少下到平原' },
  river: { name: '河谷', expansionism: 0.9, hint: '顺着大河走得快,离了河就慢' },
  lake: { name: '湖泽', expansionism: 0.8, hint: '依大湖而居,沿湖岸扩张' },
  forest: { name: '山林', expansionism: 0.7, hint: '密林、苔原里的猎人,出了林子就慢' },
};

/** 界面上的族名:"XX族" */
export function cultureLabel(cu: Culture): string {
  return `${cu.name}族`;
}

/** 界面上的州名:用户改过的(阶段 4)> 生成时起的 > "第 N 州" */
export function regionLabel(civ: Civ, r: number): string {
  return civ.regionNames?.[r] || civ.regions.name?.[r] || `第 ${r + 1} 州`;
}

/** 这个州有没有名字(用户起的或生成时起的;没有的界面上叫"第 N 州") */
export function regionNamed(civ: Civ, r: number): boolean {
  return !!(civ.regionNames?.[r] || civ.regions.name?.[r]);
}
