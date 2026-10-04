/**
 * 名字生成器内部共用的类型和小工具。
 */
import type { Rng } from '../util';

export type NameKind = 'state' | 'city' | 'mountain' | 'sea' | 'river' | 'region';
export const NAME_KINDS: NameKind[] = ['state', 'city', 'mountain', 'sea', 'river', 'region'];

/** 一个候选名。tokens 是"辨识度"部件(词根 / 意象字),用来避免连续几个名字撞同一个词根 */
export interface Candidate {
  zh: string;
  latin?: string;
  generic?: string;
  tokens: string[];
}

/** 每类名字的中文字数范围(含通名) */
export const ZH_LEN: Record<NameKind, [number, number]> = {
  state: [2, 5],
  city: [2, 5],
  region: [2, 6],
  mountain: [2, 7],
  sea: [2, 6],
  river: [2, 6],
};

export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

export interface Weighted<T> {
  item: T;
  w: number;
}

export function wpick<T>(rng: Rng, arr: readonly Weighted<T>[]): T {
  let total = 0;
  for (const a of arr) total += a.w;
  let r = rng() * total;
  for (const a of arr) {
    r -= a.w;
    if (r < 0) return a.item;
  }
  return arr[arr.length - 1].item;
}

/** 拉丁部件:l 是拉丁字母;给了 zh 就用固定译法(如 burg → 堡),否则按音节表转写;gen 表示它本身是通名 */
export interface Part {
  l: string;
  zh?: string;
  gen?: boolean;
}

/**
 * 紧凑写法 → 部件表。
 * "oria:3 ville=维尔:2 port=港!:1 -:1" → oria 权重 3;ville 固定译"维尔";port 译"港"且是通名;"-" 表示空词尾。
 */
export function parts(spec: string): Weighted<Part>[] {
  return spec
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [body, wStr] = tok.split(':');
      const [l, zhRaw] = body.split('=');
      const part: Part = { l: l === '-' ? '' : l };
      if (zhRaw !== undefined) {
        part.gen = zhRaw.endsWith('!');
        part.zh = zhRaw.replace('!', '');
      }
      return { item: part, w: wStr ? Number(wStr) : 1 };
    });
}

/** 权重都为 1 的纯列表 */
export const list = (spec: string): Part[] => parts(spec).map((p) => p.item);
