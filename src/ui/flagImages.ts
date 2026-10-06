/**
 * 地图上国都城堡插的旗:每面旗做成一张小图(SVG 转图片)存起来,画地图时直接贴。
 * 图片是异步加载的:第一次用到时还没好(返回 null,这一帧先画原来的小三角旗),加载好了通知地图重画(useFlagImages)。
 * 地图上的旗只有二十来像素宽,按小尺寸的画法画(犬牙少而大,纹样画大一点)。
 */
import { useSyncExternalStore } from 'react';
import { encodeFlag, type FlagSpec } from '../gen/civ/flags';
import { flagSvg } from '../render/flag/flagSvg';

const cache = new Map<string, HTMLImageElement>();
const MAX = 300;
let version = 0;
let pending = false;
const subs = new Set<() => void>();

function loaded() {
  // 一批旗一起加载好时只重画一次
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    version++;
    for (const f of subs) f();
  }, 30);
}

/** 这面旗的小图;还没加载好 = null */
export function flagImage(spec: FlagSpec): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  const key = encodeFlag(spec);
  let img = cache.get(key);
  if (!img) {
    if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
    img = new Image();
    img.onload = loaded;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(flagSvg(spec, { display: 24, px: 96 }))}`;
    cache.set(key, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** 有新的旗加载好了(地图按它重画) */
export function useFlagImages(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
    () => version,
  );
}
