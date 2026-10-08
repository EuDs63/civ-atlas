/**
 * 这台电脑生成一个世界大约要多久(新建世界里精细度滑条后面写"约 N 秒"):按最近一次生成实测的时间估。
 * 实测:地块多 5 倍,生成世界那一步约多 5 倍(按 0.94 次方算),铺像素、推演文明这些约多 1.4 倍(按 0.2 次方算)
 */

let last: { cells: number; genMs: number; restMs: number } | null = null;

/** 记下刚才那次生成:cells = 精细度,genMs = 生成世界那一步,totalMs = 后台线程里一共花的时间 */
export function noteGenSpeed(cells: number, genMs: number, totalMs: number): void {
  if (!(cells > 0) || !(genMs > 0) || !(totalMs >= genMs)) return;
  last = { cells, genMs, restMs: totalMs - genMs };
}

/** 精细度 cells 生成一次约几秒(至少 1 秒);还没生成过 = null */
export function genSeconds(cells: number): number | null {
  if (!last) return null;
  const r = cells / last.cells;
  return Math.max(1, Math.round((last.genMs * Math.pow(r, 0.94) + last.restMs * Math.pow(r, 0.2)) / 1000));
}
