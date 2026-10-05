/**
 * 地图上的"选目标"层(国家面板):
 *
 * - 选目标(干预页点了结盟 / 宣战 / 迁都,州的"划给…"):地图压暗(半透明层,不改渲染),只有可选的对象浮出名牌 ——
 *   颜色块 + 国名(宋体)+ 小字"相邻 / 本国";迁都时是本国城市的名牌。鼠标移到可选目标上(地图上或名牌上)名牌反色。
 *   点名牌或地图上的目标 = 下令(PolityPick.accept)。顶部提示条"选择与某国结盟的国家 · N 年起生效 · 取消 · Esc"。
 * - 下了令、正在推演:地图还压着(这期间不接受点击),只留本国和对象的名牌;顶部提示条"正在重新推演 X–3000 年"带进度。
 *   推完:面板留着、回到信息页;选对象时缩回了整张图的,地图飞回这个国家(App 从生效年份接着放,提示"…,已从 X 年起重新推演"带撤销)。
 * - 平时选中国家:国都画一个直径 24 的主色圆环,旁边写"竹影城 · 国都" —— 默认写在圆环下面,压着地图上的字(国名、城名、地名)
 *   就换到上面 / 右边 / 左边……挑一处不压字的(地图停稳了再挑,拖动、飞行时跟着圆环走)。
 * - 名牌、圆环每帧按"世界坐标 → 屏幕坐标"重新摆(平移、缩放、左右无限拖动、弯边投影、地球仪都对;转到球背面的不显示);
 *   名牌互相压着时,小国的先让开或藏起来。
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Civ } from '../gen/civ/types';
import type { World } from '../gen/world';
import { capitalAt, polityAlive } from '../gen/civ/growth';
import { ownersAt } from '../gen/civ/timeline';
import { getSelection, useCivTime, useSelection } from './civView';
import { getPolityPick, nameAt, setPickHover, setPolityPick, usePickHover, usePolityPick } from './Interventions';
import { endRun, getPanel, requestFly, setPanelTab, setSheet, usePanel } from './panelStore';
import { clearToast, showToast } from './toastStore';
import { isCoarse } from './device';
import { sideRoom } from './flyTo';
import { astRoom } from './astPanel';
import type { WorldToClient } from './EventPins';
import type { LabelPick } from './mapPick';
import './countryPanel.css';

const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`;

export interface TargetLayerProps {
  civ: Civ | null;
  world: World;
  /** App 的"世界坐标 → 屏幕坐标"(平面地图 / 地球仪;算不出、在球背面 = null) */
  toClient: MutableRefObject<WorldToClient | null>;
  /** 正在后台重推历史(干预列表变了):从哪一年起 */
  resim: { year: number } | null;
  /** 正在生成世界(它的进度条优先) */
  generating: boolean;
  /** 屏幕上这一点压着地图上的哪个字 / 城镇符号(平面地图:文字层;地球仪:球上的文字);国都旁的字躲开它们 */
  labelAt?: (clientX: number, clientY: number) => LabelPick | null;
}

interface Plate {
  key: string;
  kind: 'polity' | 'settlement';
  id: number;
  text: string;
  note: string;
  color: string;
  /** 本国 / 现在的国都:主色底 */
  self: boolean;
  /** 摆放的先后(小的先摆,压着别人时别人让开) */
  rank: number;
  x: number;
  y: number;
}

/**
 * 某一年各国名牌的位置(世界坐标):国土各州治所按面积加权的中心,再取离它最近的那个治所(保证落在国土里)。
 * x 按每国第一个州展开(跨左右接缝的国家不会被算到地图中间)
 */
function polityAnchors(civ: Civ, world: World, year: number): Map<number, { x: number; y: number; n: number }> {
  const own = ownersAt(civ, year).polity;
  const R = civ.regions;
  const { x, y } = world.mesh;
  const W = world.width;
  const acc = new Map<number, { ref: number; sx: number; sy: number; sw: number; regs: number[] }>();
  for (let r = 0; r < R.count; r++) {
    const p = own[r];
    if (p < 0) continue;
    const seat = R.seat[r];
    let a = acc.get(p);
    if (!a) acc.set(p, (a = { ref: x[seat], sx: 0, sy: 0, sw: 0, regs: [] }));
    const w = Math.max(1e-6, R.area[r]);
    a.sx += (x[seat] - W * Math.round((x[seat] - a.ref) / W)) * w;
    a.sy += y[seat] * w;
    a.sw += w;
    a.regs.push(r);
  }
  const out = new Map<number, { x: number; y: number; n: number }>();
  for (const [p, a] of acc) {
    const mx = a.sx / a.sw;
    const my = a.sy / a.sw;
    let best = a.regs[0];
    let bd = Infinity;
    for (const r of a.regs) {
      const s = R.seat[r];
      const dx = x[s] - W * Math.round((x[s] - a.ref) / W) - mx;
      const d = dx * dx + (y[s] - my) ** 2;
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    out.set(p, { x: x[R.seat[best]], y: y[R.seat[best]], n: a.regs.length });
  }
  return out;
}

/** 推演一次大约多久(上一次量到的;第一次按 0.8 秒估) */
let expectedMs = 800;

/**
 * 国都旁那行字的位置(字的中心相对圆环中心,屏幕像素):下、上、右、左、再往下 / 往上、四角。
 * 挑第一个不压着地图文字的;都压着就挑压得最少的
 */
function markTextSpot(at: [number, number], w: number, h: number, labelAt: (x: number, y: number) => LabelPick | null): [number, number] {
  const R = 15;
  const cands: [number, number][] = [
    [0, R + h / 2],
    [0, -R - h / 2],
    [R + w / 2, 0],
    [-R - w / 2, 0],
    [0, R + h * 1.5 + 2],
    [0, -R - h * 1.5 - 2],
    [R + w / 2, R + h / 2],
    [-R - w / 2, R + h / 2],
    [R + w / 2, -R - h / 2],
    [-R - w / 2, -R - h / 2],
  ];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let best = cands[0];
  let bestN = Infinity;
  for (const c of cands) {
    const x0 = at[0] + c[0] - w / 2;
    const y0 = at[1] + c[1] - h / 2;
    if (x0 < 4 || y0 < 4 || x0 + w > vw - 4 || y0 + h > vh - 4) continue;
    let n = 0;
    for (let y = y0 + 4; y <= y0 + h - 4; y += Math.max(4, (h - 8) / 2))
      for (let x = x0 + 2; x <= x0 + w - 2; x += 7) if (labelAt(x, y)) n++;
    if (n < bestN) {
      bestN = n;
      best = c;
      if (!n) break;
    }
  }
  return best;
}

export function TargetLayer({ civ, world, toClient, resim, generating, labelAt }: TargetLayerProps) {
  const pick = usePolityPick();
  const { run } = usePanel();
  const hover = usePickHover();
  const { sel } = useSelection();
  const t = useCivTime();
  const ok = !!civ && civ.viable;

  // ---- 名牌:选目标时 = 可选的对象(+ 本国);推演中 = 本国 + 对象 ----
  const plates = useMemo((): Plate[] => {
    if (!ok || !civ || (!pick && !run)) return [];
    const year = Math.floor(Math.min(civ.endYear, Math.max(0, pick?.year ?? run?.from ?? civ.endYear)));
    const out: Plate[] = [];
    const city = (sid: number, note: string, self: boolean, rank: number) => {
      const s = civ.settlements[sid];
      // 推演完、新历史里国都已经是这座城:只留一个名牌
      if (!s || out.some((p) => p.key === `s${sid}`)) return;
      const owner = civ.polities[pick?.self ?? run?.self ?? -1];
      out.push({ key: `s${sid}`, kind: 'settlement', id: sid, text: s.name || '某城', note, color: owner ? rgb(owner.color) : 'var(--ink-2)', self, rank, x: world.mesh.x[s.cell], y: world.mesh.y[s.cell] });
    };
    if (pick?.target === 'settlement') {
      const self = pick.self !== undefined ? civ.polities[pick.self] : undefined;
      if (self && polityAlive(self, year)) city(capitalAt(self, year), '国都', true, -1);
      [...(pick.eligible ?? [])].forEach((sid, i) => city(sid, '', false, i));
      return out;
    }
    if (run?.target?.kind === 'settlement') {
      const self = civ.polities[run.self];
      if (self && polityAlive(self, run.from)) city(capitalAt(self, run.from), '国都', true, -1);
      city(run.target.id, '', false, 0);
      return out;
    }
    const anchors = polityAnchors(civ, world, year);
    const add = (id: number, self: boolean) => {
      const p = civ.polities[id];
      const a = anchors.get(id);
      if (!p || !a) return;
      const note = self ? '本国' : pick?.near?.has(id) ? '相邻' : '';
      out.push({ key: `p${id}`, kind: 'polity', id, text: nameAt(p, year), note, color: rgb(p.color), self, rank: self ? -1 : -a.n, x: a.x, y: a.y });
    };
    if (pick) {
      if (pick.self !== undefined) add(pick.self, true);
      for (const id of pick.eligible ?? []) if (id !== pick.self) add(id, false);
    } else if (run) {
      add(run.self, true);
      if (run.target) add(run.target.id, false);
    }
    return out.sort((a, b) => a.rank - b.rank);
  }, [ok, civ, world, pick, run]);

  // ---- 国都的圆环:平时选中国家(面板开着、平面地图);播放时只在国都换了的时候重算 ----
  const selPolity = !ok || pick || run || sel?.kind !== 'polity' ? -1 : sel.id;
  const capId = (() => {
    const p = civ?.polities[selPolity];
    if (!civ || !p) return -1;
    const year = Math.min(civ.endYear, Math.max(0, t.year ?? civ.endYear));
    return polityAlive(p, year) ? capitalAt(p, year) : -1;
  })();
  const marker = useMemo(() => {
    const s = civ?.settlements[capId];
    return s ? { text: `${s.name} · 国都`, x: world.mesh.x[s.cell], y: world.mesh.y[s.cell] } : null;
  }, [civ, world, capId]);

  // ---- 每帧摆位置 ----
  const plateEls = useRef(new Map<string, HTMLElement>());
  const markerEl = useRef<HTMLDivElement | null>(null);
  const markerText = useRef<HTMLSpanElement | null>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const labelAtRef = useRef(labelAt);
  labelAtRef.current = labelAt;
  useEffect(() => {
    if (!plates.length && !marker) return;
    let raf = 0;
    const sizes = new Map<string, [number, number]>();
    // 国都旁的字:圆环停在同一处 2 帧后挑位置,之后每半秒再看一次(地图文字重排过)
    const spot = { key: '', still: 0 };
    const project = (x: number, y: number): [number, number] | null => toClient.current?.(x, y) ?? null;
    const tick = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 宽屏左边浮着侧栏卡片(压在名牌上面):名牌摆在卡片右边,对象在卡片底下的也挪出来,能看见、能点
      const left = sideRoom(vw);
      // 右边开着助手面板(窗口够宽、地图让出来时):名牌留在面板左边
      const right = vw - astRoom(vw);
      const placed: [number, number, number, number][] = [];
      const hov = hoverRef.current;
      // 鼠标下的那一个先摆(不会被别的挤走)
      const order = hov >= 0 ? [...plates].sort((a, b) => Number(b.id === hov && !b.self) - Number(a.id === hov && !a.self)) : plates;
      const selfFirst = [...order.filter((p) => p.self), ...order.filter((p) => !p.self)];
      for (const p of selfFirst) {
        const el = plateEls.current.get(p.key);
        if (!el) continue;
        const at = project(p.x, p.y);
        let size = sizes.get(p.key);
        if (!size || !size[0]) sizes.set(p.key, (size = [el.offsetWidth, el.offsetHeight]));
        const [w, h] = size;
        let spot: [number, number] | null = null;
        // 对象在屏幕里才摆;名牌整个留在屏幕里、侧栏卡片右边(贴边的往里挪)
        if (at && at[0] >= 0 && at[0] <= vw && at[1] >= 0 && at[1] <= vh) {
          for (const dy of [0, -1, 1, -2, 2]) {
            const cx = Math.min(right - w / 2 - 6, Math.max(left + w / 2 + 6, at[0]));
            const cy = Math.min(vh - h / 2 - 6, Math.max(h / 2 + 6, at[1] + dy * (h + 4)));
            const r: [number, number, number, number] = [cx - w / 2 - 2, cy - h / 2 - 2, cx + w / 2 + 2, cy + h / 2 + 2];
            if (placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
            placed.push(r);
            spot = [cx, cy];
            break;
          }
        }
        if (spot) {
          el.style.transform = `translate(${Math.round(spot[0] - w / 2)}px, ${Math.round(spot[1] - h / 2)}px)`;
          el.style.visibility = '';
        } else el.style.visibility = 'hidden';
      }
      if (marker && markerEl.current) {
        const at = project(marker.x, marker.y);
        markerEl.current.style.visibility = at ? '' : 'hidden';
        if (at) {
          markerEl.current.style.transform = `translate(${Math.round(at[0])}px, ${Math.round(at[1])}px)`;
          const key = `${Math.round(at[0])},${Math.round(at[1])}`;
          spot.still = key === spot.key ? spot.still + 1 : 0;
          spot.key = key;
          const el = markerText.current;
          const la = labelAtRef.current;
          if (el && la && (spot.still === 2 || (spot.still > 2 && spot.still % 30 === 0))) {
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const [ox, oy] = markTextSpot(at, w, h, la);
            el.style.transform = `translate(${Math.round(ox - w / 2)}px, ${Math.round(oy - h / 2)}px)`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [plates, marker, toClient]);

  // ---- 选目标开始:地图缩回整张图(迁都选城:留在本国);取消(没下令):回到干预页、飞回这个国家 ----
  const prevPick = useRef(pick);
  useEffect(() => {
    const was = prevPick.current;
    prevPick.current = pick;
    if (!was && pick) {
      if (pick.target !== 'settlement') requestFly('home');
    } else if (was && !pick && !getPanel().run && getSelection().sel) requestFly('sel');
  }, [pick]);

  // ---- 顶部提示条:选目标 ----
  useEffect(() => {
    if (pick && !resim && !generating)
      showToast({
        id: 'pick',
        kind: 'info',
        text: pick.msg ?? pick.prompt,
        more: [pick.msg ? pick.prompt : (pick.sub ?? '')].filter(Boolean),
        // 触屏上没有 Esc 键
        action: { label: isCoarse() ? '取消' : '取消 · Esc', onClick: () => setPolityPick(null) },
      });
    else clearToast('pick');
  }, [pick, resim, generating]);
  useEffect(() => () => clearToast('pick'), []);

  // ---- 顶部提示条:正在重新推演 X–3000 年(带进度;量不到真实进度,按上一次用的时间估,推完前停在九成多) ----
  const [busySince, setBusySince] = useState<number | null>(null);
  const endYear = civ?.endYear ?? 3000;
  useEffect(() => {
    if (!resim) return;
    const t0 = performance.now();
    setBusySince(t0);
    let timer = 0;
    const show = () => {
      if (!generating) {
        const f = Math.min(0.94, (performance.now() - t0) / expectedMs);
        showToast({ id: 'resim', kind: 'progress', text: `正在重新推演 ${Math.max(0, Math.floor(resim.year))}–${Math.floor(endYear)} 年`, progress: f });
      }
      timer = window.setTimeout(show, 60);
    };
    show();
    return () => {
      clearTimeout(timer);
      expectedMs = Math.max(300, Math.min(4000, performance.now() - t0));
      clearToast('resim');
      setBusySince(null);
    };
  }, [resim, generating, endYear]);

  // ---- 推完:面板留着、回到信息页(手机上回到半高);选对象时地图缩回了整张图,飞回这个国家(App 已经从生效年份接着放)。
  //      重推后这个国家没了(稳定键指不到),App 已经取消了选中,面板自然关掉;没推起来(比如和改地形撞上)也别卡住 ----
  const sawBusy = useRef(false);
  useEffect(() => {
    if (!run) {
      sawBusy.current = false;
      return;
    }
    if (busySince !== null) {
      sawBusy.current = true;
      return;
    }
    if (sawBusy.current) {
      sawBusy.current = false;
      endRun();
      setPanelTab('info');
      setSheet('half');
      if (run.target?.kind === 'polity' && getSelection().sel) requestFly('sel');
      return;
    }
    const timer = window.setTimeout(() => {
      if (!sawBusy.current && getPanel().run === run) endRun();
    }, 2500);
    return () => clearTimeout(timer);
  }, [run, busySince]);

  const choose = (id: number) => {
    const pk = getPolityPick();
    if (!pk) return;
    const err = pk.accept(id);
    setPolityPick(err ? { ...pk, msg: err } : null);
  };

  const dim = !!pick || !!run;
  if (!ok) return null;
  return (
    <>
      {dim && <div className={`tp-dim${run ? ' busy' : ''}`} aria-hidden="true" />}
      {plates.length > 0 && (
        <div className="tp-layer" onPointerDown={(e) => e.stopPropagation()}>
          {plates.map((p) => (
            <button
              key={p.key}
              ref={(el) => {
                if (el) plateEls.current.set(p.key, el);
                else plateEls.current.delete(p.key);
              }}
              className={`tp-plate${p.self ? ' self' : ''}${!p.self && (hover === p.id || run?.target?.id === p.id) ? ' on' : ''}`}
              data-kind={p.kind}
              data-id={p.id}
              style={{ visibility: 'hidden' }}
              disabled={!pick || p.self}
              onPointerEnter={() => pick && !p.self && setPickHover(p.id)}
              onPointerLeave={() => pick && setPickHover(-1)}
              onClick={() => !p.self && choose(p.id)}
            >
              <i className="tp-sw" style={{ background: p.color }} />
              <span className="tp-name">{p.text}</span>
              {p.note && <span className="tp-note">{p.note}</span>}
            </button>
          ))}
        </div>
      )}
      {marker && (
        <div ref={markerEl} className="tp-mark" style={{ visibility: 'hidden' }} aria-hidden="true">
          <i className="tp-ring" />
          <span ref={markerText} className="tp-mark-text">
            {marker.text}
          </span>
        </div>
      )}
    </>
  );
}

/** 冒烟检查、截图用:现在浮着的名牌(屏幕坐标) */
export function plateList(): { kind: string; id: number; text: string; note: string; x: number; y: number; on: boolean; self: boolean }[] {
  return [...document.querySelectorAll<HTMLElement>('.tp-plate')]
    .filter((el) => el.style.visibility !== 'hidden')
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        kind: el.dataset.kind ?? '',
        id: Number(el.dataset.id),
        text: el.querySelector('.tp-name')?.textContent ?? '',
        note: el.querySelector('.tp-note')?.textContent ?? '',
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        on: el.classList.contains('on'),
        self: el.classList.contains('self'),
      };
    });
}

if (typeof window !== 'undefined') (window as unknown as { __wfPlates: typeof plateList }).__wfPlates = plateList;
