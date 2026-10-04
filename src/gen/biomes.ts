/**
 * 生物群落:按"年均温 × 年降水"查 Whittaker 图。
 */

export enum Biome {
  Ocean = 0,
  Lake = 1,
  SeaIce = 2,
  Ice = 3,
  Tundra = 4,
  Taiga = 5,
  ColdDesert = 6,
  TemperateDesert = 7,
  Steppe = 8,
  TemperateForest = 9,
  TemperateRainforest = 10,
  HotDesert = 11,
  Savanna = 12,
  TropicalDryForest = 13,
  Rainforest = 14,
  Wetland = 15,
}

export interface BiomeInfo {
  name: string;
  /** 写实风格颜色 */
  real: [number, number, number];
  /** 手绘风格水彩色 */
  paint: [number, number, number];
}

const hex = (s: string): [number, number, number] => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

export const BIOMES: BiomeInfo[] = [
  { name: '海洋', real: hex('#1d4e74'), paint: hex('#a9c1c0') },
  { name: '湖泊', real: hex('#3b739a'), paint: hex('#9fbcc0') },
  { name: '海冰', real: hex('#e9eff3'), paint: hex('#eef0ea') },
  { name: '冰原', real: hex('#f3f6f8'), paint: hex('#f4f2ea') },
  { name: '苔原', real: hex('#8b8a70'), paint: hex('#cfc9ad') },
  { name: '针叶林', real: hex('#2e4a37'), paint: hex('#9fae8a') },
  { name: '寒漠', real: hex('#a49c84'), paint: hex('#d9cfae') },
  { name: '温带荒漠', real: hex('#c6b089'), paint: hex('#e6d3a4') },
  { name: '草原', real: hex('#9f9c62'), paint: hex('#d8d09a') },
  { name: '温带森林', real: hex('#46683a'), paint: hex('#b3bd8b') },
  { name: '温带雨林', real: hex('#2c5634'), paint: hex('#9fb488') },
  { name: '热带荒漠', real: hex('#d9bd8c'), paint: hex('#ecd5a0') },
  { name: '稀树草原', real: hex('#ab9c5c'), paint: hex('#dccd92') },
  { name: '热带季雨林', real: hex('#607a36'), paint: hex('#bcc38a') },
  { name: '热带雨林', real: hex('#224c27'), paint: hex('#9db482') },
  { name: '湿地', real: hex('#4b6647'), paint: hex('#b2bd98') },
];

/** ice:海冰覆盖 0–1(见 seaice.ts),只对海洋有意义;过半算海冰 */
export function classifyBiome(t: number, p: number, water: number, ice = 0): Biome {
  if (water === 1) return ice >= 0.5 ? Biome.SeaIce : Biome.Ocean;
  if (water === 2) return t < -6 ? Biome.Ice : Biome.Lake;
  if (t < -9) return Biome.Ice;
  if (t < -2) return p < 150 ? Biome.ColdDesert : Biome.Tundra;
  if (t < 5) return p < 280 ? Biome.ColdDesert : Biome.Taiga;
  if (t < 18) {
    if (p < 250) return Biome.TemperateDesert;
    if (p < 600) return Biome.Steppe;
    if (p < 1700) return Biome.TemperateForest;
    return Biome.TemperateRainforest;
  }
  if (p < 320) return Biome.HotDesert;
  if (p < 950) return Biome.Savanna;
  if (p < 1800) return Biome.TropicalDryForest;
  return Biome.Rainforest;
}
