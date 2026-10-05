/**
 * 点地图收起菜单:这一下只收起菜单,不再当成地图上的单击(不顺带选中国家、不飞过去)。
 *
 * 菜单(存档、导出、图层、「···」)在捕获阶段听 pointerdown 收起自己,收起时调 noteDismiss(e):
 * 按在地图上(主图、地球仪或地图外的空白)就记下这一下;地图的单击处理先调 tookDismissClick(),记着就把这一下的单击吃掉;
 * 地图的按下处理用 dismissing(e) 认出这一下,改地形的画线工具不从这一下开始画。
 * 只认这一下按下去的那次单击:这一下被取消(手指变成滑动)、或者松手在别处没有单击,到下一次按下时作废,
 * 不会吃掉后面的单击;按住多久都不影响。
 */

/** 记下的那一下(没有 = null) */
let armed: Event | null = null;

function disarm(e?: Event) {
  if (e && e === armed) return; // 记下的那一下自己的 pointerdown 不算"下一次"
  armed = null;
  window.removeEventListener('pointerdown', disarm, true);
  window.removeEventListener('pointercancel', disarm, true);
}

/** 菜单因为点了外面而收起:按在地图上的那一下,接下来它的单击不算 */
export function noteDismiss(e: Event) {
  const t = e.target;
  if (!(t instanceof Element && (t.matches('.stage') || t.closest('.canvas-wrap, .globe')))) return;
  armed = e;
  // 这一下被取消、或者又按了下一次:作废
  window.addEventListener('pointerdown', disarm, true);
  window.addEventListener('pointercancel', disarm, true);
}

/** 这一下按下(pointerdown)是不是刚收起菜单的那一下 */
export function dismissing(e: Event): boolean {
  return armed !== null && armed === e;
}

/** 这一下单击是不是收起菜单的那一下(问过就清掉) */
export function tookDismissClick(): boolean {
  const hit = armed !== null;
  disarm();
  return hit;
}
