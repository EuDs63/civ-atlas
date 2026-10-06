/**
 * 旗帜详情(点国家卡片顶部的小旗打开):大图、旗上每样东西的意思、这面旗怎么来的,下面「换一面」「自己改」。
 * 宽屏是卡片右边的弹层(样子同「更多图层」弹层),手机是底下升起的卡片。
 *
 * - 换一面:照同样的规矩再配 8 面(第一格是现在这面);点一面,卡片和地图马上换成它(预览),「用这面」才记下,关掉不点 = 不换
 * - 自己改:样式 / 颜色 / 图案(东方旗:底色 / 犬牙边和图案的颜色 / 神兽或纹样 / 镶边),边改边看,「完成」记下
 * - 改的是"这一国从这一朝起"的旗(键 = 这一朝的稳定键),之后的朝代照它往下配;「恢复自动配的」删掉这一国所有改动。都能撤销
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { polityName } from '../gen/civ/growth';
import { flagNote, flagRows } from '../gen/civ/flagText';
import {
  DE,
  DE_EDGE,
  DE_TINCT,
  EDIT_LAYOUTS,
  EDIT_SYMS,
  LAYOUT_COLORS,
  LAYOUT_NAME,
  MARKS,
  MARK_NAME,
  SYM_NAME,
  TINCT,
  TINCTS,
  chargeAt,
  culturePalette,
  encodeFlag,
  flagAlternatives,
  isEastern,
  isMetal,
  polityFlagKeys,
  type FlagEra,
  type FlagSpec,
  type Layout,
  type Tinct,
  underCharge,
} from '../gen/civ/flags';
import { markButtonSvg, symbolButtonSvg } from '../render/flag/flagSvg';
import { setFlags, useEdits } from './editsStore';
import { FlagIcon } from './Flag';
import { flagOf, setFlagPreview, useFlags, type FlagView } from './flagStore';
import { useNarrow } from './device';

type Mode = { m: 'info' } | { m: 'alts'; era: FlagEra; batch: number; pick: number } | { m: 'edit'; era: FlagEra; spec: FlagSpec; slot: number };

/** 每种样式的几块颜色叫什么(按 FlagSpec.c 的顺序) */
const SLOT_NAME: Record<Layout, string[]> = {
  plain: ['底'],
  'bi-h': ['上', '下'],
  'bi-v': ['左', '右'],
  'tri-h': ['上', '中', '下'],
  'tri-v': ['左', '中', '右'],
  fess: ['底', '横条'],
  pale: ['底', '竖条'],
  nordic: ['底', '十字', '十字边'],
  cross: ['底', '十字'],
  saltire: ['底', '斜十字'],
  'per-bend': ['左上', '右下'],
  chevron: ['上', '下', '三角'],
  canton: ['底', '左上角'],
  stripes: ['条纹', '间隔', '左上角'],
  bordure: ['中间', '边'],
  quarterly: ['左上', '右上'],
  disc: ['底', '圆'],
  wavy: ['底', '波纹'],
  hoist: ['底', '竖条'],
};

/** 换了样式:颜色块数跟着变(多出来的块从本族的颜色、再从全部颜色里挑没用过的) */
function fitColors(c: readonly Tinct[], n: number, pal: readonly Tinct[]): Tinct[] {
  const out = c.slice(0, n);
  for (const t of [...pal, ...TINCTS]) {
    if (out.length >= n) break;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 旗帜详情;anchor = 卡片顶部那面小旗(宽屏按它摆位置) */
export function FlagPanel({ id, year, anchor, onClose }: { id: number; year: number; anchor: RefObject<HTMLElement>; onClose: () => void }) {
  const v = useFlags();
  const narrow = useNarrow();
  const [mode, setMode] = useState<Mode>({ m: 'info' });
  const popRef = useRef<HTMLDivElement>(null);
  const edits = useEdits();

  // 换一面、自己改时的预览:改到哪一面卡片和地图就是哪一面;回到详情、关掉 = 不换
  const previewSpec = mode.m === 'alts' ? (mode.pick > 0 ? alternatives(v, id, mode.era, mode.batch)[mode.pick - 1] : null) : mode.m === 'edit' ? mode.spec : null;
  const previewKey = mode.m === 'info' ? '' : mode.era.key;
  const previewCode = previewSpec ? encodeFlag(previewSpec) : '';
  useEffect(() => {
    setFlagPreview(previewSpec ? { key: previewKey, spec: previewSpec } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, previewCode]);
  useEffect(() => () => setFlagPreview(null), []);

  // Esc 先关这个(改旗时 = 不改);点别处关掉(改旗时不关,免得白改)
  const latest = useRef({ mode, onClose });
  latest.current = { mode, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current.onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchor.current?.contains(t)) return;
      if (latest.current.mode.m === 'edit') return;
      latest.current.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [anchor]);

  // 宽屏:卡片右边 10 像素,顶和小旗差不多齐;放不下(会盖住时间轴)就往上挪到顶部按钮条下面
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    if (narrow) {
      el.style.left = el.style.top = '';
      return;
    }
    const a = anchor.current?.getBoundingClientRect();
    const card = anchor.current?.closest('.sidebar, .inspector')?.getBoundingClientRect();
    if (!a || !card) return;
    const vh = window.innerHeight;
    const h = el.offsetHeight;
    let top = a.top - 23;
    if (top + h > vh - 90) top = Math.max(8, Math.min(64, vh - h - 8));
    el.style.left = `${Math.round(card.right + 10)}px`;
    el.style.top = `${Math.round(top)}px`;
  });

  const era = v ? flagOf(v, id, year) : null;
  if (!v || !era) return null;
  const host = anchor.current?.closest('.app');
  if (!host) return null;
  const { civ } = v;
  const p = civ.polities[id];
  const name = polityName(p, year);
  const edited = polityFlagKeys(civ, id).some((k) => edits.flags?.[k]);

  const restore = () => {
    setFlagPreview(null);
    setFlags(polityFlagKeys(civ, id), null);
    setMode({ m: 'info' });
  };
  const commit = (e: FlagEra, spec: FlagSpec) => {
    setFlagPreview(null);
    if (encodeFlag(spec) !== encodeFlag(e.spec)) setFlags([e.key], encodeFlag(spec));
    setMode({ m: 'info' });
  };

  let body;
  if (mode.m === 'info') {
    const rows = flagRows(civ, v.book, id, era);
    body = (
      <>
        <div className="fl-head">
          <b>{name}的旗</b>
          <CloseBtn onClick={onClose} />
        </div>
        <div className="fl-big">
          <FlagIcon spec={era.spec} w={292} />
        </div>
        <div className="lp-sec">旗上画的是什么</div>
        <div className="fl-rows">
          {rows.map((r, i) => (
            <div className="fl-row" key={i}>
              <span className="fl-k">
                {r.k}
                {r.sw && (
                  <span className="fl-sws">
                    {r.sw.map((t) => (
                      <i key={t} className="fl-sw" style={{ background: TINCT[t].hex }} />
                    ))}
                  </span>
                )}
              </span>
              <span className="fl-v">{r.v}</span>
            </div>
          ))}
        </div>
        <div className="fl-note">
          {flagNote(era)}
          {edited && (
            <>
              {' '}
              <button className="fl-link" data-act="flag-restore" onClick={restore}>
                恢复自动配的
              </button>
            </>
          )}
        </div>
        <div className="fl-acts">
          <button className="fl-btn" data-act="flag-alts" onClick={() => setMode({ m: 'alts', era, batch: 0, pick: 0 })}>
            换一面
          </button>
          <button className="fl-btn" data-act="flag-edit" onClick={() => setMode({ m: 'edit', era, spec: era.spec, slot: 0 })}>
            自己改
          </button>
        </div>
      </>
    );
  } else if (mode.m === 'alts') {
    const list = [mode.era.spec, ...alternatives(v, id, mode.era, mode.batch)];
    const cu = civ.cultures[p.culture]?.name ?? '';
    const s = mode.era.spec;
    const how = isEastern(s)
      ? '底色照五德不变，换神兽或纹样、犬牙边的颜色和旗形。'
      : s.charge?.sym === 'tamga'
        ? `都照${cu}人的颜色，换样式和烙印。`
        : `都照${cu}人的颜色和${name}王室兴起的城来配。`;
    body = (
      <>
        <div className="fl-head">
          <b>换一面</b>
          <CloseBtn onClick={onClose} />
        </div>
        <div className="fl-note fl-lead">{how}点一面，卡片和地图上马上换成它。</div>
        <div className="fl-alts" role="radiogroup" aria-label="换一面">
          {list.map((x, i) => (
            <button key={`${mode.batch}-${i}`} className={`fl-alt${i === mode.pick ? ' on' : ''}`} role="radio" aria-checked={i === mode.pick} onClick={() => setMode({ ...mode, pick: i })}>
              <FlagIcon spec={x} w={92} />
              {i === 0 && <small>现在这面</small>}
            </button>
          ))}
        </div>
        <div className="fl-acts">
          <button className="fl-btn primary" data-act="flag-use" onClick={() => commit(mode.era, list[mode.pick])}>
            用这面
          </button>
          <button className="fl-btn" data-act="flag-more" onClick={() => setMode({ ...mode, batch: mode.batch + 1, pick: 0 })}>
            再换一批
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="fl-head">
          <b>改旗帜</b>
          <CloseBtn onClick={onClose} />
        </div>
        <div className="fl-big fl-mid">
          <FlagIcon spec={mode.spec} w={180} />
        </div>
        {isEastern(mode.spec) ? (
          <EastEditor spec={mode.spec} onSpec={(spec) => setMode({ ...mode, spec })} />
        ) : (
          <WestEditor
            spec={mode.spec}
            slot={mode.slot}
            pal={culturePalette(v.world.params.seed, civ, p.culture)}
            onSpec={(spec, slot = mode.slot) => setMode({ ...mode, spec, slot })}
          />
        )}
        <div className="fl-acts">
          <button className="fl-btn primary" data-act="flag-done" onClick={() => commit(mode.era, mode.spec)}>
            完成
          </button>
          <button className="fl-btn" data-act="flag-restore" onClick={restore}>
            恢复自动配的
          </button>
        </div>
      </>
    );
  }

  return createPortal(
    <>
      {narrow && <div className="fl-dim" onPointerDown={() => mode.m !== 'edit' && onClose()} />}
      <div ref={popRef} className={`lp-pop fl-pop fl-${mode.m}`} role="dialog" aria-label={mode.m === 'info' ? `${name}的旗` : mode.m === 'alts' ? '换一面' : '改旗帜'} onWheel={(e) => e.stopPropagation()}>
        {narrow && <i className="fl-grip" aria-hidden="true" />}
        {body}
      </div>
    </>,
    host,
  );
}

/** 换一面的候选(同一个历史、同一朝、同一批只算一次) */
const altCache = new WeakMap<FlagView['civ'], Map<string, FlagSpec[]>>();
function alternatives(v: FlagView | null, id: number, era: FlagEra, batch: number): FlagSpec[] {
  if (!v) return [];
  let m = altCache.get(v.civ);
  if (!m) altCache.set(v.civ, (m = new Map()));
  const k = `${id}|${era.key}|${encodeFlag(era.spec)}|${batch}`;
  let list = m.get(k);
  if (!list) m.set(k, (list = flagAlternatives(v.world, v.civ, id, era, batch, 8)));
  return list;
}

function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="fl-x" data-act="flag-close" aria-label="关闭" onClick={onClick}>
      ✕
    </button>
  );
}

/** 一排颜色圆点 */
function Colors({ ts, on, onPick, label }: { ts: readonly Tinct[]; on?: Tinct; onPick: (t: Tinct) => void; label?: string }) {
  return (
    <div className="fl-cols" role="radiogroup" aria-label={label}>
      {label && <span className="fl-note">{label}</span>}
      {ts.map((t) => (
        <button key={t} className={`fl-col${t === on ? ' on' : ''}`} role="radio" aria-checked={t === on} title={TINCT[t].name} aria-label={TINCT[t].name} style={{ background: TINCT[t].hex }} onClick={() => onPick(t)} />
      ))}
    </div>
  );
}

/** 西幻、汗国、共和国的旗:样式、几块颜色、图案、图案的颜色 */
function WestEditor({ spec, slot, pal, onSpec }: { spec: FlagSpec; slot: number; pal: Tinct[]; onSpec: (s: FlagSpec, slot?: number) => void }) {
  const n = LAYOUT_COLORS[spec.layout];
  const names = SLOT_NAME[spec.layout];
  const at = Math.min(slot, n - 1);
  // 样式的缩略图用现在的颜色画
  const lays = EDIT_LAYOUTS.map((l) => ({ l, spec: { shape: 'rect', layout: l, c: fitColors(spec.c, LAYOUT_COLORS[l], pal) } as FlagSpec }));
  const setLayout = (layout: Layout) => {
    const c = fitColors(spec.c, LAYOUT_COLORS[layout], pal);
    const charge = spec.charge && { ...spec.charge, at: spec.shape === 'swallow' && layout === 'plain' ? ('hoist' as const) : chargeAt(layout) };
    onSpec({ ...spec, layout, c, charge }, Math.min(slot, c.length - 1));
  };
  const setColor = (t: Tinct) => onSpec({ ...spec, c: spec.c.map((x, i) => (i === at ? t : x)) });
  const setSym = (sym: (typeof EDIT_SYMS)[number] | null) => {
    if (!sym) {
      const { charge: _, ...rest } = spec;
      onSpec(rest);
      return;
    }
    const old = spec.charge;
    const where = old?.at ?? (spec.shape === 'swallow' && spec.layout === 'plain' ? 'hoist' : chargeAt(spec.layout));
    // 新加的图案:颜色和底子有反差(底是金属色就挑本族的颜色,反之挑金属色)
    const under = underCharge(spec, where);
    const t = old?.t ?? (isMetal(under) ? (pal.find((x) => !isMetal(x) && x !== under) ?? 'R') : (pal.find((x) => isMetal(x) && x !== under) ?? 'Y'));
    onSpec({ ...spec, charge: { sym, t, at: where, ...(sym === 'tamga' ? { tamga: old?.tamga ?? 0o11 } : {}) } });
  };
  return (
    <>
      <div className="lp-sec">样式</div>
      <div className="fl-lays" role="radiogroup" aria-label="样式">
        {lays.map((x) => (
          <button key={x.l} className={`fl-lay${x.l === spec.layout ? ' on' : ''}`} role="radio" aria-checked={x.l === spec.layout} title={LAYOUT_NAME[x.l]} aria-label={LAYOUT_NAME[x.l]} onClick={() => setLayout(x.l)}>
            <FlagIcon spec={x.spec} w={43} />
          </button>
        ))}
      </div>
      <div className="lp-sec">颜色</div>
      <div>
        <div className="fl-slots">
          {spec.c.slice(0, n).map((t, i) => (
            <button key={i} className={`fl-slot${i === at ? ' on' : ''}`} aria-pressed={i === at} onClick={() => onSpec(spec, i)}>
              <i style={{ background: TINCT[t].hex }} />
              {names[i]}
            </button>
          ))}
        </div>
        <Colors ts={TINCTS} on={spec.c[at]} onPick={setColor} />
      </div>
      <div className="lp-sec">图案</div>
      <div className="fl-syms" role="radiogroup" aria-label="图案">
        <button className={`fl-sym none${spec.charge ? '' : ' on'}`} role="radio" aria-checked={!spec.charge} onClick={() => setSym(null)}>
          不要
        </button>
        {EDIT_SYMS.map((s) => (
          <SvgBtn key={s} on={spec.charge?.sym === s} title={SYM_NAME[s]} svg={symbolButtonSvg(s)} onClick={() => setSym(s)} />
        ))}
      </div>
      {spec.charge && <Colors ts={TINCTS} on={spec.charge.t} label="图案的颜色" onPick={(t) => onSpec({ ...spec, charge: { ...spec.charge!, t } })} />}
    </>
  );
}

/** 东方旗:底色(五德)、犬牙边和图案的颜色、神兽或纹样、镶边 */
function EastEditor({ spec, onSpec }: { spec: FlagSpec; onSpec: (s: FlagSpec) => void }) {
  const base = spec.c[0];
  const setMark = (mark: (typeof MARKS)[number] | null) => {
    if (!mark) {
      const { mark: _, ...rest } = spec;
      onSpec(rest);
    } else onSpec({ ...spec, mark });
  };
  // 换底色:犬牙边、镶边和新底色撞色(看不出来)时换成这一德常用的
  const setBase = (t: Tinct, de: number) =>
    onSpec({ ...spec, c: [t, ...spec.c.slice(1)], edge: spec.edge === t ? DE_EDGE[de] : spec.edge, ...(spec.trim === t ? { trim: t === 'R' ? 'W' : 'R' } : {}) });
  const setTrim = (on: boolean) => {
    if (!on) {
      const { trim: _, ...rest } = spec;
      onSpec(rest);
    } else onSpec({ ...spec, trim: base === 'R' ? 'W' : 'R' });
  };
  return (
    <>
      <div className="lp-sec">底色</div>
      <div className="fl-cols" role="radiogroup" aria-label="底色">
        {DE_TINCT.map((t, i) => (
          <button
            key={t}
            className={`fl-col${t === base ? ' on' : ''}`}
            role="radio"
            aria-checked={t === base}
            title={`${TINCT[t].name}，${DE[i]}德`}
            aria-label={`${TINCT[t].name}，${DE[i]}德`}
            style={{ background: TINCT[t].hex }}
            onClick={() => setBase(t, i)}
          />
        ))}
      </div>
      <div className="lp-sec">{spec.shape === 'banner' ? '犬牙边和图案的颜色' : '图案的颜色'}</div>
      <Colors ts={TINCTS} on={spec.edge} onPick={(edge) => onSpec({ ...spec, edge })} />
      <div className="lp-sec">神兽或纹样</div>
      <div className="fl-syms" role="radiogroup" aria-label="神兽或纹样">
        <button className={`fl-sym none${spec.mark ? '' : ' on'}`} role="radio" aria-checked={!spec.mark} onClick={() => setMark(null)}>
          不要
        </button>
        {MARKS.map((m) => (
          <SvgBtn key={m} on={spec.mark === m} title={MARK_NAME[m]} svg={markButtonSvg(m)} onClick={() => setMark(m)} />
        ))}
      </div>
      <div className="lp-sec">镶边</div>
      <div className="fl-seg" role="radiogroup" aria-label="镶边">
        <button className={`fl-slot${spec.trim ? '' : ' on'}`} role="radio" aria-checked={!spec.trim} onClick={() => setTrim(false)}>
          没有
        </button>
        <button className={`fl-slot${spec.trim ? ' on' : ''}`} role="radio" aria-checked={!!spec.trim} onClick={() => setTrim(true)}>
          有
        </button>
      </div>
    </>
  );
}

function SvgBtn({ on, title, svg, onClick }: { on: boolean; title: string; svg: string; onClick: () => void }) {
  return <button className={`fl-sym${on ? ' on' : ''}`} role="radio" aria-checked={on} title={title} aria-label={title} onClick={onClick} dangerouslySetInnerHTML={{ __html: svg }} />;
}
