/**
 * 助手面板开没开(右上的「助手」按钮、手机右上第三个按钮开关它;面板本身在 Assistant.tsx,对话在 assistantStore.ts)。
 *
 * 宽屏:面板是右边一张卡片(宽 AST_W,四周留 14),和左边的世界卡片对称。窗口够宽(≥ AST_WIDE)时地图那一块往左让:
 * 右上按钮、右下地球和缩放、时间轴、提示条都挪到面板左边(desktop.css 的 --ast-room 和这里的 astRoom 一致);
 * 窗口窄时面板盖在地图上,不再挤地图。手机:面板是一张拉到顶的底部卡片,不让位。
 */
import { useSyncExternalStore } from 'react';
import { NARROW_MAX } from './device';

/** 面板宽 */
export const AST_W = 372;
/** 窗口至少这么宽,打开面板时地图才往左让 */
export const AST_WIDE = 1280;

let open = false;
const subs = new Set<() => void>();
const get = () => open;
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
function set(v: boolean) {
  if (v === open) return;
  open = v;
  subs.forEach((f) => f());
}

export function openAssistant() {
  set(true);
}
export function closeAssistant() {
  set(false);
}
export function toggleAssistant() {
  set(!open);
}
export function getAstOpen(): boolean {
  return open;
}
export function useAstOpen(): boolean {
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * 宽屏右边被助手面板占掉的宽度:面板 + 左边留空(和 desktop.css 的 --ast-room 一致);
 * 面板没开、窗口不够宽(面板盖在地图上)、窄屏 = 0。sw = 舞台宽
 */
export function astRoom(sw: number): number {
  return open && sw > NARROW_MAX && sw >= AST_WIDE ? AST_W + 14 : 0;
}
