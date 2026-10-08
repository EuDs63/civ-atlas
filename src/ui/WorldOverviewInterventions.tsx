/**
 * 世界概览的"我的干预"页:所有干预按下达先后列出 —— "2940 年起 · 大昌:保护 · 撤销";
 * 后面接着地形大事(按添加的先后)—— "1600 年 · 海水漫进来:揽霞城一带,10 座城沉没 · 撤销"。
 * 新历史里没生效的干预写明原因(国家没出现、那一年它还没立国……,见 chronicle.ts 的 interventionOutcome)。
 * 点正文 = 收起概览、时间轴跳到那一年、选中那个国家 / 州(地形大事:和在编年史里点那一条一样);
 * "撤销" = 删掉这一条(App 在后台重推历史,推完提示"已撤销")。
 * 干预、地形大事都没有时:一句提示,说明从哪里下干预。
 */
import type { Civ } from '../gen/civ/types';
import type { World } from '../gen/world';
import { interventionOutcome } from '../gen/civ/chronicle';
import { fullChronicle } from '../gen/civ/religionText';
import { polityAlive, polityName, populationAt } from '../gen/civ/growth';
import { cleanIntervention, keyCells, regionOfKey, type Intervention, type Upheaval } from '../gen/edits';
import { interventionText, polityIdOf } from './Interventions';
import { removeIntervention, removeUpheaval, useEdits } from './editsStore';
import { pickChronicleEntry, setCivTime, setSelection, type MapSelection } from './civView';
import { closeOverview } from './overviewStore';
import { upheavalName } from './upheavalStore';

/**
 * editsStore 里的干预(可能夹着认不出的)→ 每一条在这份历史的 Civ.interventions 里是第几条
 * (−1 = 认不出 / 对不上:这份历史还不是按现在的列表推出来的,比如正在重推)
 */
function civIndexes(civ: Civ, list: readonly unknown[]): number[] {
  const done = civ.interventions ?? [];
  let c = 0;
  return list.map((x) => {
    const v = cleanIntervention(x);
    if (!v) return -1;
    if (c < done.length && JSON.stringify(done[c]) === JSON.stringify(v)) return c++;
    return -1;
  });
}

/** 这条干预在这份历史里没生效的原因(生效了 = null) */
function whyNot(civ: Civ, v: Intervention, i: number): string | null {
  const r = interventionOutcome(civ, i);
  if (r.annal >= 0) return r.ok ? null : (r.why ?? '没有生效');
  if (v.kind === 'found') return '没有推演到这一条';
  const id = polityIdOf(civ, v.a);
  if (id < 0) return '新历史里没有这个国家';
  const p = civ.polities[id];
  if (p.founded > v.from) return `${polityName(p, p.founded)}第 ${Math.floor(p.founded)} 年才立国`;
  return polityAlive(p, v.from) ? '没有生效' : '那一年它还不在';
}

/** 点一条跳去看的东西:立国 = 立出来的国家(没立成 = 那一州);划州 = 那一州;其余 = 下令的国家 */
function targetOf(civ: Civ, v: Intervention, i: number): MapSelection | null {
  if (v.kind === 'found') {
    const e = i >= 0 ? civ.annals.find((x) => x.kind === 'intervene' && x.war === i) : undefined;
    if (e && e.a >= 0) return { kind: 'polity', id: e.a };
  }
  if (v.kind === 'found' || v.kind === 'cede') {
    const r = regionOfKey(v.region, keyCells(civ.regions));
    return r >= 0 && r < civ.regions.count ? { kind: 'region', id: r } : null;
  }
  const id = polityIdOf(civ, v.a);
  return id >= 0 ? { kind: 'polity', id } : null;
}

/** 点到折线(只有一个点 = 到那个点)的距离,x 绕一圈 */
function lineDist(pts: readonly number[], px: number, py: number, W: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const bx = i + 2 < pts.length ? pts[i + 2] : ax;
    const by = i + 2 < pts.length ? pts[i + 3] : ay;
    for (const dx of [-W, 0, W]) {
      const qx = px + dx;
      const vx = bx - ax;
      const vy = by - ay;
      const L = vx * vx + vy * vy;
      const t = L ? Math.max(0, Math.min(1, ((qx - ax) * vx + (py - ay) * vy) / L)) : 0;
      best = Math.min(best, Math.hypot(qx - ax - t * vx, py - ay - t * vy));
    }
  }
  return best;
}

/**
 * 一件地形大事的一句话:"海水漫进来:揽霞城一带,10 座城沉没" / "地震抬升:库那汗国和萨尔斯坦帝国之间"。
 * 哪一带 = 笔下那一年还在的最大的城(笔下没有城 = 离第一笔最近的城);连起了两块陆地 = 两边的国家。
 * 后果按这份历史(Civ.upheavals 里合进这一件的那一条:沉没 / 被毁的城、连起的陆地;同一年的几件合成了一条的,每座城、连起的两边算给笔离它最近的那一件)
 */
export function upheavalText(civ: Civ | null, world: World | null, ups: readonly Upheaval[], i: number): { text: string; k: number } {
  const u = ups[i];
  const name = upheavalName(u);
  const k = civ?.upheavals?.findIndex((f) => f.items.includes(i)) ?? -1;
  if (!civ || !world || k < 0) return { text: name, k };
  const F = civ.upheavals![k];
  const y = F.year;
  const t = y - 1 / 256;
  const { x, y: my } = world.mesh;
  const W = world.width;
  // 同一年的几件合成了一条:后果算给笔离它最近的那一件
  const near = (v: Upheaval, s: number) => Math.min(...v.ops.map((o) => lineDist(o.pts, x[s], my[s], W) / o.r));
  const mine = (...cells: number[]) => {
    if (F.items.length < 2) return true;
    const score = (v: Upheaval | undefined) => (v ? cells.reduce((a, c) => a + near(v, c), 0) : Infinity);
    let best = F.items[0];
    for (const j of F.items) if (score(ups[j]) < score(ups[best])) best = j;
    return best === i;
  };
  let where = '';
  const onlyRaise = u.ops.every((o) => o.kind === 'raise');
  const seats = F.joined?.map((r) => civ.regions.seat[r]).filter((c) => c !== undefined) ?? [];
  if (onlyRaise && F.joined && F.joinedBy && mine(...seats)) {
    const side = (j: number) => {
      const p = F.joinedBy![j];
      return p >= 0 && civ.polities[p] ? polityName(civ.polities[p], t) : (civ.regions.name?.[F.joined![j]] ?? '荒野');
    };
    where = `${side(0)}和${side(1)}之间`;
  } else {
    const alive = civ.settlements.filter((s) => s.founded < y && (s.ended === undefined || s.ended >= y));
    const under = alive.filter((s) => u.ops.some((o) => lineDist(o.pts, x[s.cell], my[s.cell], W) < o.r));
    under.sort((a, b) => populationAt(b, t) - populationAt(a, t) || a.id - b.id);
    let city = under[0];
    if (!city) {
      const [px, py] = u.ops[0].pts;
      let bd = Infinity;
      for (const s of alive) {
        const d = lineDist([px, py], x[s.cell], my[s.cell], W);
        if (d < bd) [bd, city] = [d, s];
      }
    }
    if (city) where = `${city.name}一带`;
  }
  const sunk = civ.annals.filter((e) => e.kind === 'sunk' && e.war === k && mine(civ.settlements[e.settlement].cell));
  const drowned = sunk.filter((e) => e.b === 1).length;
  const burnt = sunk.length - drowned;
  const what = [drowned ? `${drowned} 座城沉没` : '', burnt ? `${burnt} 座城被毁` : ''].filter(Boolean).join('、');
  return { text: `${name}：${where || '荒野'}${what ? `，${what}` : ''}`, k };
}

export function InterventionsPage({ civ, world, busy }: { civ: Civ | null; world: World | null; busy: boolean }) {
  const edits = useEdits();
  const list = edits.interventions;
  const ups = edits.upheavals ?? [];
  const upRows = ups.map((u, i) => {
    const { text, k } = upheavalText(busy ? null : civ, world, ups, i);
    return (
      <div key={`u${i}`} className="ov-iv up">
        <span className="ov-iv-year">{u.year} 年</span>
        <button
          className="ov-iv-text"
          onClick={() => {
            closeOverview();
            // 和在编年史里点那一条一样:跳到那一年、地图上闪出那一带
            const e = civ && k >= 0 ? fullChronicle(civ).find((x) => x.kind === 'upheaval' && civ.annals[x.id]?.a === k) : undefined;
            if (e) pickChronicleEntry(e);
            else setCivTime({ year: u.year, playing: false, scrubbing: false, story: false });
          }}
          title="时间轴跳到这一年,在地图上标出那一带"
        >
          {text}
        </button>
        <button className="ov-link ov-undo" data-act="up-undo" onClick={() => removeUpheaval(i)} title="撤销这件地形大事(从那一年起重新推演)">
          撤销
        </button>
      </div>
    );
  });
  if (!list.length && !ups.length)
    return (
      <div className="ov-empty ov-iv-empty" data-empty="interventions">
        还没有干预。点击地图上的国家,选择「干预历史」。
      </div>
    );
  if (!civ) return <div className="ov-empty">正在生成世界</div>;
  if (!list.length) return <div className="ov-ivs">{upRows}</div>;
  // 这份历史是按现在的列表推出来的(认不出的除外),才能按下标核对哪条生效了
  const ci = civIndexes(civ, list);
  const same = ci.filter((c) => c >= 0).length === (civ.interventions?.length ?? 0) && ci.every((c, i) => c >= 0 || !cleanIntervention(list[i]));
  return (
    <div className="ov-ivs">
      {list.map((raw, i) => {
        const v = cleanIntervention(raw);
        const undo = (
          <button className="ov-link ov-undo" data-act="iv-undo" onClick={() => removeIntervention(i)} title="撤销这条干预(之后的历史重新推演)">
            撤销
          </button>
        );
        if (!v)
          return (
            <div key={i} className="ov-iv off">
              <span className="ov-iv-year">—</span>
              <span className="ov-iv-text">认不出的干预(推演时不管它)</span>
              {undo}
            </div>
          );
        const idx = same ? ci[i] : -1;
        const why = busy || !same ? null : whyNot(civ, v, idx);
        const target = same ? targetOf(civ, v, idx) : null;
        return (
          <div key={i} className={`ov-iv${why ? ' off' : ''}`}>
            <span className="ov-iv-year">{v.from} 年起</span>
            <button
              className="ov-iv-text"
              onClick={() => {
                closeOverview();
                setCivTime({ year: v.from, playing: false, scrubbing: false, story: false });
                if (target) setSelection(target);
              }}
              title="时间轴跳到这一年,在地图上选中它"
            >
              {interventionText(civ, v, idx)}
              {why && <em>未生效:{why}</em>}
            </button>
            {undo}
          </div>
        );
      })}
      {upRows}
    </div>
  );
}
