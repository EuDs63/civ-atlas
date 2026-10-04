/**
 * 右上"搜索"弹出的框(宽 280):输入即出结果(最多 8 条),点一条 = 关框 + 选中它(地图飞过去由选中那边做)。
 * Esc、点框外面关上;上下键 + 回车只是加速。查找本身在 searchIndex.ts。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Civ } from '../gen/civ/types';
import { getCivTime, setSelection } from './civView';
import { searchCiv, type SearchHit } from './searchIndex';
import './search.css';

export function SearchBox({ civ, onClose, anchor }: { civ: Civ; onClose: () => void; anchor?: React.RefObject<HTMLElement> }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // 年份取打开搜索那一刻的(播放时不跟着每一年重算)
  const year = useMemo(() => getCivTime().year ?? civ.endYear, [civ]);
  const hits = useMemo(() => searchCiv(civ, q, year), [civ, q, year]);
  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    input.current?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || box.current?.contains(t) || anchor?.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, anchor]);

  const pick = (h: SearchHit) => {
    onClose();
    setSelection(h.select);
  };

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div ref={box} className="search-box" role="dialog" aria-label="搜索" onPointerDown={stop} onWheel={stop} onDoubleClick={stop}>
      <input
        ref={input}
        className="search-input"
        value={q}
        placeholder="国家、城市或民族"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = hits.length;
            if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          } else if (e.key === 'Enter' && hits[active]) {
            e.preventDefault();
            pick(hits[active]);
          }
        }}
      />
      {hits.length > 0 ? (
        <div className="search-list" role="listbox">
          {hits.map((h, i) => (
            <button
              key={`${h.kind}:${h.id}`}
              className={`search-row${i === active ? ' on' : ''}`}
              role="option"
              aria-selected={i === active}
              data-kind={h.kind}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(h)}
            >
              <i className="search-sw" style={{ background: h.color }} />
              <span className="search-name">{h.name}</span>
              <span className="search-sub">{h.sub}</span>
            </button>
          ))}
        </div>
      ) : (
        q.trim() && <div className="search-empty">没有找到「{q.trim()}」</div>
      )}
    </div>
  );
}
