/**
 * 小旗:国家卡片顶部(39 × 26,手机 36 × 24)、朝代表(24 × 16)、首屏国家列表和别的列表(21 × 14)。
 * 旗都是 3 : 2;大小由各处的 CSS 定,这里只按显示宽度决定画多细(render/flag/flagSvg.ts 的小尺寸简化)。
 * 外面一圈 0.5 像素的淡边(白旗在白底上也看得出)在 flags.css 里,燕尾旗的在 SVG 里描。
 */
import { useMemo, type ReactNode } from 'react';
import { encodeFlag, type FlagSpec } from '../gen/civ/flags';
import { flagSvg } from '../render/flag/flagSvg';
import { getCivTime } from './civView';
import { flagOf, useFlags } from './flagStore';
import './flags.css';

/** 画好的 SVG 按"旗 + 画多细"存一份(神兽要算轮廓,列表里同一面旗出现很多次) */
const cache = new Map<string, string>();
const CACHE_MAX = 400;

export function flagHtml(spec: FlagSpec, display: number): string {
  const detail = display < 30 ? 2 : display < 60 ? 1 : 0;
  const key = `${encodeFlag(spec)}|${detail}`;
  let s = cache.get(key);
  if (!s) {
    s = flagSvg(spec, { display });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, s);
  }
  return s;
}

/** 一面旗;w = 显示宽度(CSS 像素,只用来定画多细) */
export function FlagIcon({ spec, w, className = '', title }: { spec: FlagSpec; w: number; className?: string; title?: string }) {
  const code = encodeFlag(spec);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => flagHtml(spec, w), [code, w]);
  return <i className={`fl${spec.shape === 'swallow' ? ' swallow' : ''}${className ? ` ${className}` : ''}`} title={title} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 某国在某年的旗(year 不给 = 时间轴现在那一年;没立国 = 第一面,已亡 = 最后一面)。
 * 还算不出旗(世界还在生成)= fallback(一般是原来的颜色小方块)
 */
export function PolityFlag({ id, year, w, className, fallback = null }: { id: number; year?: number; w: number; className?: string; fallback?: ReactNode }) {
  const v = useFlags();
  const e = flagOf(v, id, year ?? getCivTime().year ?? Infinity);
  return e ? <FlagIcon spec={e.spec} w={w} className={className} /> : <>{fallback}</>;
}
