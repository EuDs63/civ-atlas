/**
 * 左下角的最近事件:到时间轴当前年份为止最近的 4 条大事,越新越清楚(最新的在最下面)。
 * 窄屏(手机)只显示最新的 1 条,在时间轴上方一行;底部抽屉打开时藏起来(App 给 rows、hidden)。
 * 一行:年份(宋体)· 类型(彩色粗体)· 纪事正文。点一条 = 在编年史里点那一条(civView.ts 的 pickChronicleEntry):
 * 时间轴跳到那一年、地图上闪出事发地,事发地不在视野里就把地图移过去;地图上那一条的标签停约 5 秒。
 *
 * 用的纪事和地图上的事件标签一致:编年史的"大事"(编年史只看某国时就只看这国的)。
 * 播放时只在"最近 4 条"变了的时候重新渲染。
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { Civ } from '../gen/civ/types';
import { buildChronicle, filterChronicle } from '../gen/civ/chronicle';
import { getCivTime, pickChronicleEntry, subscribeCivTime, useChronicle } from './civView';
import { useThemeCompat } from './CivTimeline';
import { countUpTo, evLabel, evText, evType } from './timelineLayout';
import './timeline.css';

/** 最多几条 */
const ROWS = 4;
/** 从旧到新的不透明度(最新的一条 = 1) */
const FADE = [0.4, 0.55, 0.75, 1];

const subscribe = (f: () => void) => subscribeCivTime(() => f());

export interface RecentEventsProps {
  civ: Civ | null;
  /** 地质回放时藏起来 */
  hidden?: boolean;
  /** 显示几条(默认 4;窄屏 1) */
  rows?: number;
}

export function RecentEvents({ civ, hidden, rows = ROWS }: RecentEventsProps) {
  const chron = useChronicle();
  const [setRoot, compat] = useThemeCompat();
  const has = !!civ && civ.viable && civ.cultures.length > 0;
  const end = civ?.endYear ?? 0;
  const entries = useMemo(() => (has ? filterChronicle(buildChronicle(civ), { major: true, polity: chron.polity }) : []), [civ, has, chron.polity]);
  // 到当前年份为止有几条(只在它变了时重新渲染)
  const k = useSyncExternalStore(subscribe, () => countUpTo(entries, Math.min(end, Math.max(0, getCivTime().year ?? end))));
  if (!has || hidden || !k) return null;
  const list = entries.slice(Math.max(0, k - Math.max(1, Math.min(ROWS, rows))), k);
  const fade = FADE.slice(FADE.length - list.length);
  return (
    <div ref={setRoot} className={`recent-ev${compat ? ' tb-compat' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {list.map((e, i) => (
        <button key={e.id} className="recent-row" data-ev={evType(e)} style={{ ['--o' as string]: fade[i] }} onClick={() => pickChronicleEntry(e)}>
          <span className="recent-year">{Math.floor(e.year)}</span>
          <b className="tb-ev">{evLabel(e)}</b>
          <span className="recent-text">{evText(e)}</span>
        </button>
      ))}
    </div>
  );
}
