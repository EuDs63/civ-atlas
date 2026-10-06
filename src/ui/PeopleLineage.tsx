/**
 * 人物页「君主」只看一国时的世系图(WorldOverviewPeople.tsx 右上「列表 | 世系图」切过来):一朝一棵家谱树。
 *
 *   左边  朝代一列(手机上换成一排横滑的按钮):一朝一行,名字、年份、几位;时间轴那一年的那一朝标「当前」;点一行换树。下面是图例
 *   右边  标题"景  2377–2794 年，27 位君主；太祖柳渺玄起兵代衍朝开国"(手机上不写开国那句),下面这一朝的树(排法见 gen/civ/lineageInfo.ts):
 *         白底方框 = 即位的君主(左边灰色数字是这一朝第几位,两行:称呼、在位年份);虚线框 = 没即位的宗室(生卒);
 *         时间轴那一年在位的标「当前」、蓝框,还没即位(宗室:还没出生)的变淡;从人物卡片进来的那位蓝框圈出。
 *         最后一位下面写这一朝怎么结束("2794 年，渊朝起兵代之");连不上开国那一支的远支另起一小棵。点一位看他的卡片
 * 看哪一朝:人物卡片进来 = 他那一朝;别的 = 时间轴那一年的那一朝(还没立国 = 第一朝,亡了 = 最后一朝);打开时滚到圈出的那位或「当前」。
 * 树比右边宽时左右滑,长的上下滑(手机上整页上下滑)。
 */
import { Fragment, useLayoutEffect, useMemo, useRef } from 'react';
import type { Civ, Person } from '../gen/civ/types';
import { rulerAt } from '../gen/civ/peopleInfo';
import { personName } from '../gen/civ/peopleText';
import { dynastyEnd, dynastyNote, dynastyRowAt, dynastyRows, layoutDynasty, reignOrder, type DynastyRow, type LineageTree } from '../gen/civ/lineageInfo';
import { setPeople } from './overviewStore';
import { selectPerson } from './panelParts';
import { useNarrow } from './device';

const F = Math.floor;

/** 方框大小、间距(电脑 / 手机);FONT = 名字的字号(估名字多宽用) */
const BOX = { wide: { W: 136, H: 44, GAP: 18, STEP: 68, FONT: 13.5 }, narrow: { W: 128, H: 42, GAP: 12, STEP: 64, FONT: 13 } };
/** 方框里名字以外占的宽(左边序号、内边距,多留 1 像素) */
const CHROME = 39;
/** 名字很长(西幻的"多布罗斯拉夫一世")时方框最宽放到这么宽 */
const W_MAX = 188;
/** 树四周留的边 */
const PAD = 4;
/** 最后一位下面那句话占的高 */
const TAIL_H = 30;

type Box = (typeof BOX)['wide'];

let measure: { ctx: CanvasRenderingContext2D | null; family: string } | undefined;
/** 一段粗体字有多宽(按页面的字体量;量不了就按一字一个字号宽估) */
function textWidth(text: string, px: number): number {
  if (!measure) {
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
    measure = { ctx, family: getComputedStyle(document.body).fontFamily };
  }
  if (!measure.ctx) return [...text].length * px * 1.05;
  measure.ctx.font = `600 ${px}px ${measure.family}`;
  return measure.ctx.measureText(text).width;
}

const nameWidth = (civ: Civ, p: Person, box: Box) => textWidth(personName(civ, p), box.FONT);
/** 「当前」小标签连同前面的空隙占多宽(字 11 号,左右内边距各 5,空隙 5) */
const badgeWidth = () => textWidth('当前', 11) + 15;

const yearSpan = (a: number, b: number | undefined) => `${F(a)}–${b !== undefined ? F(b) : ''}`;

function inRow(row: DynastyRow, year: number) {
  return row.from <= year && (row.to === undefined || year < row.to);
}

/** 一棵树:方框绝对定位,连线画在底下的 svg 里;tail = 最后一位下面那句话(这一棵里有最后一位才给) */
function Tree({ civ, row, tree, box, year, cur, focus, tail }: { civ: Civ; row: DynastyRow; tree: LineageTree; box: Box; year: number; cur: Person | null; focus: number | null; tail: string }) {
  const { W, H, GAP, STEP } = box;
  const unit = W + GAP;
  const xs = tree.nodes.map((n) => n.x);
  const minX = Math.min(...xs);
  const maxD = Math.max(...tree.nodes.map((n) => n.depth));
  const cx = (x: number) => (x - minX) * unit + W / 2 + PAD;
  const top = (d: number) => d * STEP + PAD;
  const width = (Math.max(...xs) - minX) * unit + W + PAD * 2;
  const height = maxD * STEP + H + PAD * 2 + (tail ? TAIL_H : 0);
  const at = new Map(tree.nodes.map((n) => [n.p, n]));
  const future = (p: Person) => (p.role === 'ruler' ? (p.from ?? p.born) > year : p.born > year);
  const last = tail ? tree.nodes.filter((n) => n.p.role === 'ruler').sort((a, b) => (b.p.from ?? 0) - (a.p.from ?? 0))[0] : undefined;
  const lines: { d: string; fut: boolean }[] = [];
  for (const n of tree.nodes) {
    const ks = tree.nodes.filter((k) => k.p.parent === n.p.id && at.has(k.p));
    if (!ks.length) continue;
    const y0 = top(n.depth) + H;
    const ym = y0 + (STEP - H) / 2;
    const kx = ks.map((k) => cx(k.x));
    const allFut = ks.every((k) => future(k.p));
    lines.push({ d: `M${cx(n.x)} ${y0}V${ym}`, fut: allFut });
    lines.push({ d: `M${Math.min(...kx, cx(n.x))} ${ym}H${Math.max(...kx, cx(n.x))}`, fut: allFut });
    for (const k of ks) lines.push({ d: `M${cx(k.x)} ${ym}V${top(k.depth)}`, fut: future(k.p) });
  }
  return (
    <div className="lg-tree" style={{ width, height }}>
      <svg width={width} height={height} aria-hidden="true">
        {lines.map((l, i) => (
          <path key={i} d={l.d} className={l.fut ? 'fut' : undefined} />
        ))}
      </svg>
      {tree.nodes.map(({ p, x, depth }) => {
        const k = reignOrder(row, p);
        const on = k > 0 && p === cur;
        const cls = `lg-node${k ? '' : ' lg-prince'}${on ? ' on' : ''}${future(p) ? ' fut' : ''}${p.id === focus ? ' focus' : ''}`;
        const name = personName(civ, p);
        const span = k ? yearSpan(p.from ?? p.born, p.until) : yearSpan(p.born, p.died);
        // 名字加「当前」放不下:「当前」挪到年份后面
        const low = on && CHROME + nameWidth(civ, p, box) + badgeWidth() > W;
        return (
          <button
            key={p.id}
            className={cls}
            style={{ left: cx(x) - W / 2, top: top(depth), width: W, height: H }}
            data-person={p.id}
            title={`${name}，${k ? `${span} 年在位` : `未即位，${span}`}`}
            onClick={() => selectPerson(p.id)}
          >
            {k > 0 && <span className="lg-n">{k}</span>}
            <span className="lg-t">
              <b>
                <span className="lg-nm">{name}</span>
                {on && !low && <em className="cp-badge">当前</em>}
              </b>
              <em>
                {span}
                {low && <em className="cp-badge">当前</em>}
              </em>
            </span>
          </button>
        );
      })}
      {last && (
        <div className="lg-tail" style={{ left: cx(last.x) - 120, top: top(last.depth) + H + 8 }}>
          {tail}
        </div>
      )}
    </div>
  );
}

export function PeopleLineage({ civ, polity, dynasty, focus, year }: { civ: Civ; polity: number; dynasty: number | null; focus: number | null; year: number }) {
  const narrow = useNarrow();
  const box0 = narrow ? BOX.narrow : BOX.wide;
  const rows = useMemo(() => dynastyRows(civ, polity), [civ, polity]);
  const byYear = dynastyRowAt(rows, year);
  const picked = dynasty !== null ? rows.findIndex((r) => r.index === dynasty) : -1;
  const ri = picked >= 0 ? picked : byYear;
  const row = rows[ri];
  const trees = useMemo(() => (row ? layoutDynasty(civ, row) : []), [civ, row]);
  // 这一朝最长的名字放不下就把方框放宽些(东方的名字都放得下,只有西幻的长名字会放宽)
  const box = useMemo(() => {
    const longest = Math.max(0, ...trees.flatMap((t) => t.nodes.map((n) => nameWidth(civ, n.p, box0))));
    return { ...box0, W: Math.min(W_MAX, Math.max(box0.W, Math.ceil(CHROME + longest))) };
  }, [civ, trees, box0]);
  const tail = useMemo(() => dynastyEnd(civ, rows, ri), [civ, rows, ri]);
  // 最后一位在哪一棵(结尾那句写在他下面)
  const lastTree = useMemo(() => {
    const lastRuler = row?.rulers[row.rulers.length - 1];
    return trees.findIndex((t) => t.nodes.some((n) => n.p === lastRuler));
  }, [trees, row]);
  const cur = rulerAt(civ, polity, year);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  // 换了国家、朝代、圈出的人:滚到圈出的那位(没有 = 「当前」;都没有 = 树的最上面);从最上面就看得到的不滚
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const el = sc.querySelector<HTMLElement>('.lg-node.focus') ?? sc.querySelector<HTMLElement>('.lg-node.on');
    // 手机上整页上下滑(朝代按钮、标题跟着滑走),树只左右滑
    const v = narrow ? (sc.closest('.chron-list') as HTMLElement | null) : sc;
    if (!el) {
      sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
      if (v) v.scrollTop = 0;
    } else {
      const tree = el.offsetParent as HTMLElement;
      sc.scrollLeft = Math.max(0, tree.offsetLeft + el.offsetLeft + el.offsetWidth / 2 - sc.clientWidth / 2);
      if (v) {
        // 在 v 里的位置(手机:树在整页里还要加上朝代按钮、标题的高)
        const y = tree.offsetTop + el.offsetTop + (v === sc ? 0 : sc.offsetTop);
        const fits = y + el.offsetHeight + 24 <= v.clientHeight;
        v.scrollTop = fits ? 0 : Math.max(0, y - v.clientHeight * 0.4);
      }
    }
    const chips = chipsRef.current;
    const on = chips?.querySelector<HTMLElement>('.lg-chip.on');
    if (chips && on) chips.scrollLeft = Math.max(0, on.offsetLeft - chips.offsetLeft - 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [civ, polity, ri, focus, narrow]);

  if (!row) return null;
  const pick = (r: DynastyRow) => setPeople({ dynasty: r.index, focus: null });
  const dyns = narrow ? (
    <div className="lg-chips" ref={chipsRef}>
      {rows.map((r, i) => (
        <button key={r.index} className={`lg-chip${i === ri ? ' on' : ''}`} data-dynasty={r.index} onClick={() => pick(r)}>
          <b>
            {r.name}
            {inRow(r, year) && <em className="cp-badge">当前</em>}
          </b>
          <span>
            {F(r.from)}
            {r.to !== undefined ? `–${F(r.to)}` : ' 年起'}，{r.rulers.length} 位
          </span>
        </button>
      ))}
    </div>
  ) : (
    <nav className="lg-dyns" aria-label="朝代">
      <h4>朝代</h4>
      {rows.map((r, i) => (
        <button key={r.index} className={`lg-dyn${i === ri ? ' on' : ''}`} data-dynasty={r.index} onClick={() => pick(r)}>
          <b>
            {r.name}
            {inRow(r, year) && <em className="cp-badge">当前</em>}
          </b>
          <small>{r.rulers.length} 位</small>
          <span>
            {F(r.from)}
            {r.to !== undefined ? `–${F(r.to)}` : ''} 年{r.to === undefined ? '起' : ''}
          </span>
        </button>
      ))}
      <div className="lg-legend">
        <div>
          <i className="lg-key" />
          即位的君主，数字是这一朝第几位
        </div>
        <div>
          <i className="lg-key prince" />
          没即位的宗室
        </div>
        <div>点一位看他的卡片</div>
      </div>
    </nav>
  );
  return (
    <div className={`lg-wrap${narrow ? ' lg-phone' : ''}`} data-lineage={polity}>
      {dyns}
      <div className="lg-main">
        <div className="lg-head">
          <b>{row.name}</b>
          <span>{narrow ? dynastyNote(civ, rows, ri).split('；')[0] : dynastyNote(civ, rows, ri)}</span>
        </div>
        <div className="lg-scroll" ref={scrollRef}>
          {trees.map((t, i) => (
            <Fragment key={i}>
              {t.distant && <div className="lg-distant">宗室远支</div>}
              <Tree civ={civ} row={row} tree={t} box={box} year={year} cur={cur} focus={focus} tail={i === lastTree ? tail : ''} />
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
