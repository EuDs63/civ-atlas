/**
 * 世界概览的"我的干预"页:所有干预按下达先后列出 —— "2940 年起 · 大昌:保护 · 撤销"。
 * 新历史里没生效的写明原因(国家没出现、那一年它还没立国……,见 chronicle.ts 的 interventionOutcome)。
 * 点正文 = 收起概览、时间轴跳到那一年、选中那个国家 / 州;"撤销" = 删掉这一条(App 在后台重推历史,推完提示"已撤销")。
 * 没有干预时:一句提示,说明从哪里下干预。
 */
import type { Civ } from '../gen/civ/types';
import { interventionOutcome } from '../gen/civ/chronicle';
import { polityAlive, polityName } from '../gen/civ/growth';
import { cleanIntervention, regionOfKey, type Intervention } from '../gen/edits';
import { interventionText, polityIdOf } from './Interventions';
import { removeIntervention, useEdits } from './editsStore';
import { setCivTime, setSelection, type MapSelection } from './civView';
import { closeOverview } from './overviewStore';

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
    const r = regionOfKey(v.region, civ.regions.of);
    return r >= 0 && r < civ.regions.count ? { kind: 'region', id: r } : null;
  }
  const id = polityIdOf(civ, v.a);
  return id >= 0 ? { kind: 'polity', id } : null;
}

export function InterventionsPage({ civ, busy }: { civ: Civ | null; busy: boolean }) {
  const edits = useEdits();
  const list = edits.interventions;
  if (!list.length)
    return (
      <div className="ov-empty ov-iv-empty" data-empty="interventions">
        还没有干预。点击地图上的国家,选择「干预历史」。
      </div>
    );
  if (!civ) return <div className="ov-empty">正在生成世界</div>;
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
    </div>
  );
}
