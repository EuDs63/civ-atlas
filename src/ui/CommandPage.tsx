/**
 * 国家面板的干预页:生效年份(−100 −10 [年份] +10,默认 = 时间轴当前那一年)+ 六条命令。
 *
 *   立即生效  保护(不会被灭亡)、禁止分裂、禁止扩张
 *   选择对象  结盟(任意国家)、宣战(仅相邻国家)、迁都(本国城市)→ 在地图上选(地图压暗、可选的对象浮出名牌,见 TargetPlates.tsx)
 *
 * 不可用的命令变淡,说明换成原因。下了令:面板收起,顶部提示条"正在重新推演 X–3000 年",推完"已从 X 年重新推演 · …"带撤销,
 * 从 X 年接着放(App.tsx、TargetPlates.tsx)。命令的数据和推演沿用 editsStore / gen/edits 的干预。
 */
import { useMemo, useState } from 'react';
import type { Civ } from '../gen/civ/types';
import { capitalAt, polityAlive, populationAt } from '../gen/civ/growth';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { polityKey, settlementKey, type Intervention, type InterventionKind } from '../gen/edits';
import { addIntervention, useEdits } from './editsStore';
import { cityStands, defaultYear, nameAt, neighborsAt, polityOrders, setPolityPick, type PolityPick } from './Interventions';
import { endRun, setPanelTab, startRun } from './panelStore';
import { setCivTime } from './civView';
import { YearStepper, useYearInput } from './panelParts';

let owners: Owners | undefined;

type Cmd = 'protect' | 'unity' | 'halt' | 'ally' | 'declare' | 'move';

const CMDS: { k: Cmd; name: string; desc: string; pick: boolean }[] = [
  { k: 'protect', name: '保护', desc: '该国不会被灭亡', pick: false },
  { k: 'unity', name: '禁止分裂', desc: '该国不会分裂出新国家', pick: false },
  { k: 'halt', name: '禁止扩张', desc: '该国疆域不再增加', pick: false },
  { k: 'ally', name: '结盟', desc: '选择一个国家,两国不再交战', pick: true },
  { k: 'declare', name: '宣战', desc: '选择一个相邻国家', pick: true },
  { k: 'move', name: '迁都', desc: '选择本国的一座城市', pick: true },
];

export function CommandPage({ civ, id, year }: { civ: Civ; id: number; year: number }) {
  const edits = useEdits();
  const p = civ.polities[id];
  const key = polityKey(civ, id);
  // 生效年份的范围:立国那年 … 亡国前一年(至多结束年份前一年)
  const lo = Math.ceil(p.founded);
  const hi = Math.max(lo, Math.min(civ.endYear - 1, p.ended !== undefined ? Math.ceil(p.ended) - 1 : civ.endYear - 1));
  const [msg, setMsg] = useState<string | null>(null);
  const yi = useYearInput(defaultYear(p, year), lo, hi, () => setMsg(null));
  const { y, valid } = yi;

  const alive = polityAlive(p, y);
  const { size, near } = useMemo(() => neighborsAt(civ, id, y), [civ, id, y]);
  const others = useMemo(() => civ.polities.filter((q) => q.id !== id && polityAlive(q, y) && (size.get(q.id) ?? 0) > 0).map((q) => q.id), [civ, id, y, size]);
  // 迁都的候选:那一年本国国土里还在的、不是国都的城
  const cities = useMemo(() => {
    if (!alive) return [];
    owners = ownersAt(civ, y, owners);
    const own = owners.polity;
    const cap = capitalAt(p, y);
    return civ.settlements.filter((s) => s.id !== cap && own[s.region] === id && cityStands(civ, s.id, y) && populationAt(s, y) > 0).map((s) => s.id);
  }, [civ, id, p, y, alive]);
  const orders = polityOrders(civ, id, edits.interventions);
  // 下过同一种命令(有截止年份的,到期以后可以再下)
  const has = (kind: InterventionKind) =>
    orders.some(({ v }) => v.kind === kind && v.kind !== 'found' && v.a === key && !('until' in v && v.until !== undefined && y >= v.until));
  const name = nameAt(p, y);

  /** 这一条命令为什么用不了(能用 = null) */
  const why = (k: Cmd): string | null => {
    if (!valid) return `生效年份要在 ${lo}–${hi} 年之间`;
    if (!alive) return y < p.founded ? `${y} 年还没立国` : `${y} 年已亡`;
    if ((k === 'protect' || k === 'unity' || k === 'halt') && has(k)) return '已经下过这条命令';
    if (k === 'ally' && !others.length) return '该年没有别的国家';
    if (k === 'declare' && !near.size) return '该年没有相邻的国家';
    if (k === 'move' && !cities.length) return '该年本国没有别的城市';
    return null;
  };

  /** 下令:面板收起、后台重推;这条已经下过 = 原因 */
  const order = (v: Intervention, target: { kind: 'polity' | 'settlement'; id: number } | null): string | null => {
    startRun({ self: id, target, from: y });
    if (!addIntervention(v)) {
      endRun();
      return '这条命令已经下过了';
    }
    setMsg(null);
    return null;
  };

  const run = (k: Cmd) => {
    setMsg(null);
    if (k === 'protect' || k === 'unity' || k === 'halt') {
      setMsg(order({ kind: k, a: key, from: y }, null));
      return;
    }
    const base = { sub: `${y} 年起生效`, source: `polity:${id}`, self: id, near, year: y };
    let pk: PolityPick;
    if (k === 'move') {
      const ok = new Set(cities);
      pk = {
        ...base,
        prompt: `选择${name}的新国都`,
        target: 'settlement',
        eligible: ok,
        accept: (sid) => {
          const s = civ.settlements[sid];
          if (!s) return '这里没有城,点一座城';
          if (capitalAt(p, y) === sid) return `${s.name}本来就是国都`;
          if (!ok.has(sid)) return `${y} 年${s.name}不在${name}的国土里`;
          return order({ kind: 'move', a: key, city: settlementKey(civ, sid), from: y }, { kind: 'settlement', id: sid });
        },
      };
    } else {
      const ok = new Set(k === 'ally' ? others : [...near]);
      pk = {
        ...base,
        prompt: k === 'ally' ? `选择与${name}结盟的国家` : `选择${name}要宣战的国家`,
        eligible: ok,
        accept: (q) => {
          if (q === id) return '要选另一个国家';
          const Q = civ.polities[q];
          if (!Q || !polityAlive(Q, y) || !(size.get(q)! > 0)) return `${y} 年${Q ? nameAt(Q, y) : '这个国家'}不在`;
          if (k === 'declare' && !near.has(q)) return '两国不接壤,无法宣战';
          return order({ kind: k, a: key, b: polityKey(civ, q), from: y }, { kind: 'polity', id: q });
        },
      };
    }
    // 地图停在生效那一年:看到的国界、可选的对象和命令用的是同一年
    setCivTime({ year: y, playing: false, scrubbing: false, story: false });
    setPolityPick(pk);
  };

  return (
    <>
      <div className="cp-body">
        <YearStepper yi={yi} />
        <div className="cp-cmds">
          {CMDS.map((c) => {
            const off = why(c.k);
            return (
              <button key={c.k} className={`cp-cmd${off ? ' off' : ''}`} data-cmd={c.k} disabled={!!off} onClick={() => run(c.k)}>
                <span className="cp-cmd-main">
                  <span className="cp-cmd-name">{c.name}</span>
                  <span className="cp-cmd-desc">{off ?? c.desc}</span>
                </span>
                {!off && <span className="cp-cmd-go">{c.pick ? '选择对象 ›' : '立即生效'}</span>}
              </button>
            );
          })}
        </div>
        {msg && <div className="cp-msg">{msg}</div>}
      </div>
      <div className="cp-foot">
        <button className="cp-btn wide" data-act="back" onClick={() => setPanelTab('info')}>
          返回
        </button>
      </div>
    </>
  );
}
