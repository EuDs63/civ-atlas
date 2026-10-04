/**
 * 底部时间轴:播放 / 暂停、"第 N 年"、1× / 4×、时间轴(刻度 + 事件菱形 + 干预"令" + 播放头)。
 * 窄屏(手机)整条排成一行,1× / 4× 并成一个按钮(点一下换另一档)。
 * 编年史在世界概览里(国家面板"相关事件 · 全部 ›"也能到),时间轴上不另放按钮。
 *
 * - 打开网页、第一个世界显示出来时,从第 2600 年(结束年份前 400 年)起按 1× 自动播放;放到结束年份停下,
 *   再点播放从第 2600 年重播(网址给了 civYear、play=0,或在无头浏览器里不自动播放,见 civView.ts)。
 * - 1× = 每秒 20 年,4× = 每秒 80 年;"回放世界形成"放完地质接着放文明时(story),从第 0 年用 15 秒放完一遍,
 *   这时自动打开"民族"和"国家",顶部显示"人类登场 / 列国并起"的说明。
 * - 干预重推完,App 调 playFrom(生效年份) 从那一年接着放;选中国家等看详情时暂停(civView.ts 的 setSelection)。
 * - 年份存在 civView.ts 里,地图(CivLayer)、图层弹层的民族图例和悬停信息(civDescribe)都读它。
 * - 刻度、菱形、"令"、悬停提示、拖动 / 点击在 TimelineMarks.tsx;播放头和进度按 CSS 变量 --p 画,播放时刻度不重新渲染。
 *   刻度用的纪事和编年史列出的一致:默认"大事",编年史切到"全部"或只看某国时,刻度跟着变。
 * - 放哪:dock="bottom"(默认)浮在地图底部一整行;"top" 浮在顶部;
 *   "inline" 不定位,填满父元素(放进别的布局的一行里时用;App 就是这样放进底部那一行的)。
 * - 颜色用主题变量(--ink、--line-strong、--ev-war……,见 timeline.css),没有主题时用浅色默认值。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Civ } from '../gen/civ/types';
import { buildChronicle, filterChronicle } from '../gen/civ/chronicle';
import {
  clearChroniclePick,
  getCivTime,
  pausePlayback,
  resetCivTime,
  setCivShow,
  setCivTime,
  startAutoplay,
  takeAutoplay,
  useChronicle,
  useCivTime,
} from './civView';
import { TimelineMarks } from './TimelineMarks';
import { useNarrow } from './device';
import { PLAY_RATE, STORY_SECONDS, replayStart } from './timelineLayout';
import './timeline.css';

export interface CivTimelineProps {
  civ: Civ | null;
  /** 地质回放时藏起来 */
  hidden?: boolean;
  /** 浮在地图底部(默认)/ 顶部(数据图层的图例占着底部时)/ 不定位、填满父元素 */
  dock?: 'top' | 'bottom' | 'inline';
}

export function CivTimeline({ civ, hidden, dock = 'bottom' }: CivTimelineProps) {
  const t = useCivTime();
  const narrow = useNarrow();
  const chron = useChronicle();
  const has = !!civ && civ.viable && civ.cultures.length > 0;
  const end = civ?.endYear ?? 0;
  const year = Math.min(end, Math.max(0, t.year ?? end));
  const [rootRef, compat] = useThemeCompat();

  // 换了新世界:回到结束年份(第一次拿到文明时保留网址里的 civYear)。
  // 按州(地理)认世界:改名(阶段 4)只换 civ 对象、州还是同一份,时间轴不动
  const prev = useRef<Civ['regions'] | null>(null);
  const world = civ?.regions ?? null;
  useEffect(() => {
    if (prev.current && prev.current !== world) {
      resetCivTime();
      clearChroniclePick();
    }
    prev.current = world;
  }, [world]);

  // 打开网页后第一个世界:从结束年份前 400 年起自动播放(只一次)
  useEffect(() => {
    if (has && takeAutoplay()) startAutoplay(replayStart(end));
  }, [has, end]);

  // 刻度用的纪事:和编年史面板列出的一致(buildChronicle 按 civ 缓存;只在换世界 / 换筛选时重算,播放时不变)
  const all = useMemo(() => (has ? buildChronicle(civ) : []), [civ, has]);
  const marks = useMemo(() => filterChronicle(all, { major: chron.major, polity: chron.polity }), [all, chron.major, chron.polity]);

  // 播放:每帧按真实流逝的时间推进年份
  useEffect(() => {
    if (!t.playing) return;
    if (!has) {
      setCivTime({ year: null, playing: false, story: false });
      return;
    }
    if (t.story) setCivShow({ cultures: true, polities: true });
    const rate = t.story ? end / STORY_SECONDS : PLAY_RATE[t.speed] ?? PLAY_RATE[1];
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - last));
      last = now;
      const cur = getCivTime();
      if (!cur.playing) return;
      const ny = (cur.year ?? 0) + (dt / 1000) * rate;
      if (ny >= end) {
        setCivTime({ year: null, playing: false, story: false });
        return;
      }
      setCivTime({ year: ny });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [t.playing, t.story, t.speed, has, end]);

  if (!has || hidden) return null;

  const toggle = () => {
    if (t.playing) pausePlayback();
    // 放到头了(停在结束年份):从结束年份前 400 年重播
    else setCivTime({ playing: true, story: false, scrubbing: false, year: year >= end ? replayStart(end) : year });
  };
  const n = Math.floor(year);
  const firstPolity = civ.polities.length ? Math.min(...civ.polities.map((p) => p.founded)) : Infinity;
  const story =
    year < firstPolity
      ? '人类登场:各民族从发源地出发,一年年向外扩散,沿途建起村镇'
      : '列国并起:城市长大,人口够多的城立国,国家向外扩张、升格';
  const p = Math.min(1, year / Math.max(1, end));
  return (
    <>
      {t.story && t.playing && (
        <div className={`civ-top${dock === 'top' ? ' dock-top' : ''}`}>
          <div className="caption">
            <div className="big">第 {n} 年</div>
            <div className="small">{story}</div>
            <div className="track">
              <div style={{ width: `${p * 100}%`, transition: 'none' }} />
            </div>
          </div>
        </div>
      )}
      <div
        ref={rootRef}
        className={`civ-timeline timebar dock-${dock}${compat ? ' tb-compat' : ''}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        style={{ ['--p' as string]: p }}
      >
        <button className={`tb-play${t.playing ? ' on' : ''}`} onClick={toggle} aria-label={t.playing ? '暂停' : '播放'} title={t.playing ? '暂停' : '播放'}>
          <i aria-hidden="true" />
        </button>
        <span className="tb-year">第 {n} 年</span>
        {narrow ? (
          <button className="tb-speed tb-speed-one" onClick={() => setCivTime({ speed: t.speed === 4 ? 1 : 4 })} aria-label={`播放速度 ${t.speed}×,点一下换成 ${t.speed === 4 ? 1 : 4}×`}>
            {t.speed}×
          </button>
        ) : (
          <span className="tb-speed" role="group" aria-label="播放速度">
            {([1, 4] as const).map((s) => (
              <button key={s} className={t.speed === s ? 'on' : ''} aria-pressed={t.speed === s} onClick={() => setCivTime({ speed: s })}>
                {s}×
              </button>
            ))}
          </span>
        )}
        <TimelineMarks entries={marks} end={end} dock={dock} year={n} />
      </div>
    </>
  );
}

/**
 * 主题变量还没定义时(界面主题 theme.css 没加载;这时页面 :root 里就算有 --panel、--line、--accent,也可能是别的样式表定的深色值),
 * 组件根元素加 tb-compat,timeline.css 在组件里把这几个换成浅色默认值。以 --ink 有没有定义为准,
 * 根元素挂上时查一次。返回 [挂在根元素上的 ref, 要不要加 tb-compat]
 */
export function useThemeCompat(): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [compat, setCompat] = useState(false);
  useLayoutEffect(() => {
    if (el) setCompat(getComputedStyle(el).getPropertyValue('--ink').trim() === '');
  }, [el]);
  return [setEl, compat];
}
