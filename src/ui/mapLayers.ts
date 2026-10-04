/**
 * 图层(界面骨架的"图层与投影"弹层):六张缩略图 + 三个数据图层小字按钮。
 *
 * 一个图层 = 画风(手绘 / 写实 / 数据图层)+ 数据图层(数据图层时)+ 文明层开不开国家 / 民族:
 *   政区 = 手绘 + 国家      民族 = 手绘 + 民族      地形 = 手绘,不叠文明
 *   生态 = 数据图层"群落"   高程 = 数据图层"海拔"   实景 = 写实地貌,不叠文明
 *   板块 / 气温 / 降水 = 对应的数据图层
 * 反过来,任意一组(画风, 数据图层, 国家 / 民族开关)都能认出它算哪个图层(旧链接 style=、layer=、civ= 照样认)。
 * 主题:高程、实景、降水底色深,界面换深色;其余浅色。
 */
import type { LayerId as DataLayer } from '../render/layers';

export type Style = 'realistic' | 'fantasy' | 'data';

export type MapLayer = 'political' | 'cultures' | 'terrain' | 'biomes' | 'elevation' | 'realistic' | 'plates' | 'temperature' | 'precipitation';

export interface LayerDef {
  id: MapLayer;
  name: string;
  style: Style;
  /** 数据图层时画哪一层 */
  data?: DataLayer;
  /** 文明层:国家 / 民族开不开 */
  polities: boolean;
  cultures: boolean;
  dark: boolean;
  /** 六张缩略图里的(false = 下面一行小字按钮) */
  main: boolean;
}

export const MAP_LAYERS: LayerDef[] = [
  { id: 'political', name: '政区', style: 'fantasy', polities: true, cultures: false, dark: false, main: true },
  { id: 'cultures', name: '民族', style: 'fantasy', polities: false, cultures: true, dark: false, main: true },
  { id: 'terrain', name: '地形', style: 'fantasy', polities: false, cultures: false, dark: false, main: true },
  { id: 'biomes', name: '生态', style: 'data', data: 'biomes', polities: false, cultures: false, dark: false, main: true },
  { id: 'elevation', name: '高程', style: 'data', data: 'elevation', polities: false, cultures: false, dark: true, main: true },
  { id: 'realistic', name: '实景', style: 'realistic', polities: false, cultures: false, dark: true, main: true },
  { id: 'plates', name: '板块', style: 'data', data: 'plates', polities: false, cultures: false, dark: false, main: false },
  { id: 'temperature', name: '气温', style: 'data', data: 'temperature', polities: false, cultures: false, dark: false, main: false },
  { id: 'precipitation', name: '降水', style: 'data', data: 'precipitation', polities: false, cultures: false, dark: true, main: false },
];

const BY_ID = new Map(MAP_LAYERS.map((l) => [l.id, l]));

export function layerDef(id: MapLayer): LayerDef {
  return BY_ID.get(id) ?? MAP_LAYERS[0];
}

export function isMapLayer(x: unknown): x is MapLayer {
  return typeof x === 'string' && BY_ID.has(x as MapLayer);
}

/** 这组设置算哪个图层(写实 + 国家也算"实景";手绘时先看国家、再看民族) */
export function layerOf(style: Style, data: DataLayer, show: { polities: boolean; cultures: boolean }): MapLayer {
  if (style === 'realistic') return 'realistic';
  if (style === 'data') return isMapLayer(data) ? data : 'biomes';
  if (show.polities) return 'political';
  if (show.cultures) return 'cultures';
  return 'terrain';
}

/** 图层用深色界面 */
export function layerDark(id: MapLayer): boolean {
  return layerDef(id).dark;
}

/**
 * 网址里的图层:带 style= 的旧链接照旧(style + layer + civ);没有 style 时 layer= 是新的图层名;
 * 都没有:civ= 开了国家 / 民族就按它(手绘),否则默认"政区"。
 * 返回 null = 按网址原样(不去改文明层的开关)
 */
export function layerFromUrl(q: URLSearchParams): MapLayer | null {
  if (q.get('style')) return null;
  const l = q.get('layer');
  if (isMapLayer(l)) return l;
  if (q.get('civ')) return null;
  return 'political';
}
