import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type WorldParams, type World } from '../src/gen/world';
import { rasterize } from '../src/gen/raster';
import { Biome } from '../src/gen/biomes';
import { generateCiv, type Civ } from '../src/gen/civ';
import { AdjKind, Layer } from '../src/gen/civ/types';
import { CivSim, Ev } from '../src/gen/civ/sim';
import { ownersAt, ownersFromScratch } from '../src/gen/civ/timeline';
import { polityModelOf } from '../src/gen/civ/polities';
import { warModelOf } from '../src/gen/civ/wars';
import { POLITY_FORMS, capitalAt, populationAt, polityAlive, polityName, polityTierAt, polityTitles, settlementRank, tierOf } from '../src/gen/civ/growth';
import { BAND, mergeChains, traceChains, borderLines, type SidedLine } from '../src/render/civ/borders';
import { labelImage, pixelRegions } from '../src/render/civ/territory';
import type { CivDrawParams, CivShow } from '../src/render/civ/overlay';
import { CIV_SHOW_OFF } from '../src/render/civ/overlay';

const small = { ...DEFAULT_PARAMS, cells: 12000 };

/**
 * 州 r 是不是国家 pid 灭国时一并收下的残部(wars.ts 的 annex:"隔海的残部最后一并归 x"):
 * r 最后一次归 pid 是攻占,而且就在那一刻有国家亡于 pid。这样收下的隔海领土,非海洋国家也会有
 */
function annexedOverseas(civ: Civ, pid: number, r: number): boolean {
  const L = civ.log;
  let last = -1;
  for (let i = 0; i < L.size; i++) if (L.region[i] === r && L.layer[i] === Layer.Polity) last = i;
  if (last < 0 || L.value[last] !== pid || L.cause[last] !== Ev.Conquer) return false;
  const y = L.year[last];
  return civ.annals.some((e) => e.kind === 'fall' && e.b === pid && e.year === y);
}


const worlds = new Map<string, World>();
function world(p: WorldParams): World {
  const key = JSON.stringify(p);
  let w = worlds.get(key);
  if (!w) worlds.set(key, (w = generateWorld(p)));
  return w;
}
const civs = new Map<string, Civ>();
function civOf(p: WorldParams): Civ {
  const key = JSON.stringify(p);
  let c = civs.get(key);
  if (!c) civs.set(key, (c = generateCiv(world(p))));
  return c;
}

function bytes(a: ArrayBufferView) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/** 州图跳数(陆上 1、海峡 2、航线 5) */
function hops(civ: Civ, from: number): Float64Array {
  const reg = civ.regions;
  const d = new Float64Array(reg.count).fill(Infinity);
  d[from] = 0;
  const q = [from];
  // 权重很小,直接反复松弛
  for (let h = 0; h < q.length; h++) {
    const r = q[h];
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const w = reg.adjKind[k] === AdjKind.SeaRoute ? 5 : reg.adjKind[k] === AdjKind.Strait ? 2 : 1;
      const j = reg.adj[k];
      if (d[r] + w < d[j]) {
        d[j] = d[r] + w;
        q.push(j);
      }
    }
  }
  return d;
}

describe('城市成长 + 国家', () => {
  it('确定性:同一个种子跑两次,城镇、国家、归属、日志逐字节相同', () => {
    const a = generateCiv(world({ ...small, seed: 2024 }));
    const b = generateCiv(generateWorld({ ...small, seed: 2024 }));
    expect(a.polities.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.settlements)).toBe(JSON.stringify(b.settlements));
    expect(JSON.stringify(a.polities)).toBe(JSON.stringify(b.polities));
    expect(bytes(a.polity).equals(bytes(b.polity))).toBe(true);
    expect(bytes(a.log.value.subarray(0, a.log.size)).equals(bytes(b.log.value.subarray(0, b.log.size)))).toBe(true);
    expect(bytes(a.log.year.subarray(0, a.log.size)).equals(bytes(b.log.year.subarray(0, b.log.size)))).toBe(true);
    expect(a.routes.length).toBe(b.routes.length);
  });

  it('默认参数:先后立国 8–40 个(含分裂 / 复国出来的)、结束时在世 8–20 个,城镇每个有人州一座;国都之间隔得开;只有海洋国家有跨海领土', () => {
    for (const seed of [7, 2024, 3, 99]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      expect(civ.polities.length, `seed ${seed}`).toBeGreaterThanOrEqual(8);
      expect(civ.polities.length, `seed ${seed}`).toBeLessThanOrEqual(40);
      // 阶段 3 有了战争、分合:有的国家灭亡了、被并了,也有分出来的
      const alive = civ.polities.filter((p) => polityAlive(p, civ.endYear)).length;
      expect(alive, `seed ${seed}`).toBeGreaterThanOrEqual(8);
      expect(alive, `seed ${seed}`).toBeLessThanOrEqual(20);
      const reg = civ.regions;
      // 城镇:每个有人住的州一座,在治所上;名字不重复
      // (阶段 3 城市兴衰:被毁的城在故址上重建的,同一州先后有几座 —— 前一座被毁了、后一座才建起,同族重建的沿用旧名)
      const cityOf = new Int32Array(reg.count).fill(-1);
      for (const s of civ.settlements) {
        if (s.rebuilds !== undefined) {
          const old = civ.settlements[s.rebuilds];
          expect(cityOf[s.region]).toBe(old.id);
          expect(old.ended).toBeLessThan(s.founded);
          if (s.name === old.name) expect(s.culture).toBe(old.culture);
        } else expect(cityOf[s.region]).toBe(-1);
        cityOf[s.region] = s.id;
        expect(s.cell).toBe(reg.seat[s.region]);
        expect(civ.culture[s.region]).toBeGreaterThanOrEqual(0);
        expect(s.name.length).toBeGreaterThan(0);
      }
      const fresh = civ.settlements.filter((s) => s.rebuilds === undefined || s.name !== civ.settlements[s.rebuilds].name);
      expect(new Set(fresh.map((s) => s.name)).size).toBe(fresh.length);
      let occupied = 0;
      for (let r = 0; r < reg.count; r++) if (civ.culture[r] >= 0) occupied++;
      expect(civ.settlements.length).toBeGreaterThan(0.95 * occupied);
      // 立国时的国都之间至少隔 3 跳(灭亡的国家撤掉了国都间距标记:只比立国时对方还在世的;
      // 分裂 / 复国出来的国家不看国都间距,国都标记还跟着迁都走:只比按"立国"立起来的国家和对方立国时的国都)
      const caps = civ.polities.map((p) => civ.settlements[p.capital].region);
      for (let i = 0; i < caps.length; i++) {
        const d = hops(civ, caps[i]);
        for (let j = i + 1; j < caps.length; j++) {
          if (!polityAlive(civ.polities[i], civ.polities[j].founded)) continue;
          if (civ.polities[j].parent !== undefined || capitalAt(civ.polities[i], civ.polities[j].founded) !== civ.polities[i].capital) continue;
          expect(d[caps[j]], `seed ${seed} 国都 ${i}–${j}`).toBeGreaterThanOrEqual(3);
        }
      }
      // 跨海领土:国土占了不止一片陆地的,一定是海洋国家 —— 除了灭国时一并收下的隔海残部(wars.ts 的 annex)
      for (const p of civ.polities) {
        const lms = new Set<number>();
        for (let r = 0; r < reg.count; r++) if (civ.polity[r] === p.id && !annexedOverseas(civ, p.id, r)) lms.add(reg.landmass[r]);
        if (lms.size > 1) expect(p.kind, `${p.name}`).toBe('sea');
      }
      // 有部落地带(有人住、没国家),但国家占了大半。修好"离国都的路程"以后(国家扩张不再莫名停住)部落地带只剩荒漠、边远处;
      // 阶段 3 分合以后,离别国国都太近没能立国的城在那个国都灭亡 / 迁走后还能补立国,分出来的新国也往身边的部落地带扩张:
      // 默认参数下约 1.5%–15%
      let inPolity = 0;
      for (let r = 0; r < reg.count; r++) if (civ.polity[r] >= 0) inPolity++;
      expect(inPolity / occupied).toBeGreaterThan(0.6);
      expect(inPolity / occupied, `seed ${seed}`).toBeLessThan(0.995);
    }
  }, 60_000);

  it('一州只归一个国家,而且是有人住的州;在世的国家,当年的国都一直在本国国土内;灭亡的国家一州不剩;国家是按年份先后立的', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const P = civ.polities.length;
      for (let i = 1; i < P; i++) expect(civ.polities[i].founded).toBeGreaterThanOrEqual(civ.polities[i - 1].founded);
      const years = [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 2999, 3000];
      for (const p of civ.polities) {
        years.push(p.founded, p.founded + 0.5);
        for (const c of p.capitals ?? []) years.push(c.year, c.year + 0.5);
        if (p.ended !== undefined) years.push(p.ended - 1 / 512, p.ended, p.ended + 1);
      }
      const out = { culture: new Int16Array(civ.regions.count), polity: new Int16Array(civ.regions.count) };
      for (const y of years) {
        const own = ownersAt(civ, y, out);
        for (let r = 0; r < civ.regions.count; r++) {
          const p = own.polity[r];
          expect(p).toBeGreaterThanOrEqual(-1);
          expect(p).toBeLessThan(P);
          if (p >= 0) {
            expect(own.culture[r], `第 ${y} 年第 ${r} 州`).toBeGreaterThanOrEqual(0);
            expect(civ.polities[p].founded).toBeLessThanOrEqual(y);
          }
        }
        for (const p of civ.polities) {
          if (y < p.founded) continue;
          if (polityAlive(p, y)) {
            expect(own.polity[civ.settlements[capitalAt(p, y)].region], `${p.name} 第 ${y} 年`).toBe(p.id);
          } else {
            expect(own.polity.includes(p.id), `${p.name} 第 ${y} 年已灭亡`).toBe(false);
          }
        }
      }
    }
  });

  it('ownersAt 对国家这一层同样成立:检查点跳转和从头翻日志一致;结束年份等于"现在"的归属', () => {
    const civ = civOf({ ...DEFAULT_PARAMS, seed: 7 });
    expect(Array.from(ownersAt(civ, civ.endYear).polity)).toEqual(Array.from(civ.polity));
    let polityEntries = 0;
    for (let i = 0; i < civ.log.size; i++) if (civ.log.layer[i] === Layer.Polity) polityEntries++;
    expect(polityEntries).toBeGreaterThan(100);
    const years: number[] = [];
    for (let i = 0; i < civ.log.size; i++) if (civ.log.layer[i] === Layer.Polity && i % 7 === 0) years.push(civ.log.year[i], civ.log.year[i] - 0.001);
    years.push(650.5, 1234.5, 2999.9);
    const out = { culture: new Int16Array(civ.regions.count), polity: new Int16Array(civ.regions.count) };
    for (const y of years) {
      const fast = ownersAt(civ, y, out);
      const slow = ownersFromScratch(civ, y);
      expect(Array.from(fast.polity), `第 ${y} 年`).toEqual(Array.from(slow.polity));
    }
  });

  it('CivSim.fromCiv 接着推:先推到第 1200 年再推到 3000 年,国家、城镇、战争和一口气推完完全一样', () => {
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      const whole = civOf({ ...small, seed });
      const half = generateCiv(w, { endYear: 1200 });
      expect(half.polities.length).toBeLessThan(whole.polities.length);
      const sim = CivSim.fromCiv(w, half);
      sim.run(3000);
      const res = sim.result();
      expect(Array.from(res.polity)).toEqual(Array.from(whole.polity));
      expect(bytes(res.log.year).equals(bytes(whole.log.year.subarray(0, whole.log.size)))).toBe(true);
      expect(bytes(res.log.value).equals(bytes(whole.log.value.subarray(0, whole.log.size)))).toBe(true);
      expect(JSON.stringify(res.annals)).toBe(JSON.stringify(whole.annals));
      const m = polityModelOf(sim)!;
      // 名字、配色、国号写法(东方 / 西幻,起名时定)在推演结束后才定,只比推演出来的部分
      const strip = <T extends { name: string; color?: unknown; dynasties?: { name: string }[] }>(a: T[]) =>
  a.map((x) => ({ ...x, name: '', color: 0, eastern: undefined, dynasties: x.dynasties?.map((d) => ({ ...d, name: '' })) }));
      expect(JSON.stringify(strip(m.settlements))).toBe(JSON.stringify(strip(whole.settlements)));
      expect(JSON.stringify(strip(m.polities))).toBe(JSON.stringify(strip(whole.polities)));
      // 战争(阶段 3):第 1200 年之后的宣战、攻占、迁都、灭亡、议和都一样;变化日志的原因(含"攻占")也一样
      expect(whole.annals.some((e) => e.kind === 'war' && e.year > 1200)).toBe(true);
      expect(whole.annals.some((e) => e.kind === 'conquer' && e.year > 1200)).toBe(true);
      expect(bytes(res.log.cause).equals(bytes(whole.log.cause.subarray(0, whole.log.size)))).toBe(true);
      const wm = warModelOf(sim)!;
      expect(wm.wars.map((w) => [w.a, w.b, w.start, w.end ?? null, w.takes.length])).toEqual(
        whole.annals
          .filter((e) => e.kind === 'war')
          .map((e) => {
            const peace = whole.annals.find((q) => q.kind === 'peace' && q.war === e.war);
            return [e.a, e.b, e.year, peace?.year ?? null, whole.annals.filter((q) => q.kind === 'conquer' && q.war === e.war).length];
          }),
      );
      expect(m.polities.map((p) => p.ended ?? null)).toEqual(whole.polities.map((p) => p.ended ?? null));
    }
  });

  it('史事:每国一条"立国"、每次升格一条"升格",按年份排好;国都变迁的第一条是立国时的国都,之后每次迁都一条"迁都"', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...small, seed });
      const A = civ.annals;
      expect(A.length).toBeGreaterThan(0);
      for (let i = 1; i < A.length; i++) expect(A[i].year).toBeGreaterThanOrEqual(A[i - 1].year);
      for (const p of civ.polities) {
        const cap = civ.settlements[p.capital];
        const found = A.filter((e) => e.kind === 'found' && e.a === p.id);
        // 分裂 / 复国出来的国家(阶段 3 分合)没有"立国",只有一条"分裂"(b = 从哪国分出来)
        if (p.parent !== undefined) {
          expect(found).toEqual([]);
          const split = A.filter((e) => e.kind === 'split' && e.a === p.id);
          expect(split).toHaveLength(1);
          expect(split[0]).toMatchObject({ year: p.founded, b: p.parent, settlement: cap.id, war: -1 });
        } else expect(found).toEqual([{ year: p.founded, kind: 'found', a: p.id, b: -1, region: cap.region, settlement: cap.id, war: -1 }]);
        const ranks = A.filter((e) => e.kind === 'rank' && e.a === p.id).map((e) => e.year);
        expect(ranks).toEqual(p.titles!.slice(1).map((t) => t.year));
        // 国都变迁:第一条是立国时的国都,之后每条对应一条"迁都"史事,或一条新朝定都根据地的"改朝换代"(阶段 3 王朝更替)
        const moves = A.filter(
          (e) => e.a === p.id && (e.kind === 'capital' || (e.kind === 'dynasty' && e.settlement !== capitalAt(p, e.year - 1 / 512))),
        );
        expect(p.capitals![0]).toEqual({ year: p.founded, settlement: p.capital });
        expect(p.capitals!.slice(1)).toEqual(moves.map((e) => ({ year: e.year, settlement: e.settlement })));
        for (const e of moves) if (e.kind === 'capital') expect(e.region).toBe(civ.settlements[e.settlement].region);
        expect(capitalAt(p, civ.endYear)).toBe(p.capitals![p.capitals!.length - 1].settlement);
      }
      for (const e of A) {
        expect([
          'found',
          'rank',
          'war',
          'conquer',
          'peace',
          'fall',
          'capital',
          'split',
          'merge',
          'dynasty',
          'migrate',
          'assimilate',
          'vanish',
          'sack',
          'ruin',
          'rebuild',
          'decline',
          'battle',
        ]).toContain(e.kind);
      }
    }
  });

  it('城市按 S 形曲线长大;国号随国土升格,记录和当年的州数一致', () => {
    const civ = civOf({ ...DEFAULT_PARAMS, seed: 2024 });
    for (const s of civ.settlements) {
      expect(populationAt(s, s.founded - 1)).toBe(0);
      // 阶段 3 城市兴衰:被洗劫过、失去过国都之位的城人口会往下走(见 civ-cities.test.ts),其余的只长不减
      const steady = !s.sacks && !s.capitalSpans?.some((x) => x.until !== undefined);
      let prev = 0;
      for (let y = Math.ceil(s.founded); y <= civ.endYear; y += 250) {
        const pop = populationAt(s, y);
        expect(Number.isFinite(pop)).toBe(true);
        expect(pop).toBeGreaterThanOrEqual(0);
        if (steady && (s.ended === undefined || y < s.ended)) expect(pop).toBeGreaterThanOrEqual(prev);
        expect(pop).toBeLessThanOrEqual(s.capacity * 1.6 + 1e-9);
        prev = pop;
      }
    }
    // 结束时各级城市都有,村镇多、大城少
    const ranks = [0, 0, 0, 0];
    for (const s of civ.settlements) ranks[settlementRank(populationAt(s, civ.endYear))]++;
    expect(ranks.every((n) => n > 0)).toBe(true);
    expect(ranks[3]).toBeLessThan(ranks[2]);
    expect(ranks[2]).toBeLessThan(ranks[1]);
    // 国号:第一条是立国那年、第 0 档(分裂 / 复国出来的国家:按起事那年的州数定档);之后只升不降
    // (打了败仗、国土缩小也不降:历史上缩小的帝国照样叫帝国);结束时的档位 ≥ 州数对应的档位
    let empires = 0;
    for (const p of civ.polities) {
      const t = p.titles!;
      if (p.parent === undefined) expect(t[0]).toEqual({ year: p.founded, tier: 0 });
      else {
        const own = ownersAt(civ, p.founded);
        let n = 0;
        for (let r = 0; r < civ.regions.count; r++) if (own.polity[r] === p.id) n++;
        expect(t[0]).toEqual({ year: p.founded, tier: tierOf(n) });
      }
      for (let i = 1; i < t.length; i++) {
        expect(t[i].tier).toBeGreaterThan(t[i - 1].tier);
        expect(t[i].year).toBeGreaterThanOrEqual(t[i - 1].year);
        // 升格那年州数够了
        const own = ownersAt(civ, t[i].year);
        let n = 0;
        for (let r = 0; r < civ.regions.count; r++) if (own.polity[r] === p.id) n++;
        expect(tierOf(n)).toBeGreaterThanOrEqual(t[i].tier);
      }
      let n = 0;
      for (let r = 0; r < civ.regions.count; r++) if (civ.polity[r] === p.id) n++;
      const tier = polityTierAt(p, civ.endYear);
      expect(tier).toBe(t[t.length - 1].tier);
      if (p.ended === undefined) expect(tier).toBeGreaterThanOrEqual(tierOf(n));
      else expect(n).toBe(0);
      expect(polityName(p, civ.endYear)).toBe(polityTitles(p, civ.endYear)[tier]);
      if (!p.eastern) expect(polityName(p, civ.endYear)).toBe(p.name + POLITY_FORMS[p.lineage!][tier]);
      if (tier === 3) empires++;
      if (p.kind === 'nomad') expect(p.lineage).toBe('khanate');
    }
    expect(empires).toBeLessThan(civ.polities.length / 2);
    expect(new Set(civ.polities.map((p) => p.name)).size).toBe(civ.polities.length);
  });

  it('国界线和国土色块严丝合缝:色块只在界线两侧 BAND 以内被改判,而且就是按线的哪一侧改判的', () => {
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      const civ = civOf({ ...small, seed });
      const r = rasterize(w, 1);
      const pix = pixelRegions(w.mesh, r, civ.regions.of);
      const W = r.w;
      const H = r.h;
      for (const style of ['realistic', 'fantasy'] as const) {
        const show: CivShow = { ...CIV_SHOW_OFF, polities: true };
        const p: CivDrawParams = { world: w, raster: r, civ, style, year: civ.endYear, show };
        const lines = borderLines(p, Layer.Polity);
        expect(lines.length).toBeGreaterThan(5);
        const base = labelImage(W, H, 1, 1, pix, civ.polity, null, new Int16Array(W * H));
        const fixed = labelImage(W, H, 1, 1, pix, civ.polity, lines, new Int16Array(W * H), w.width);
        // 1. 改判的像素都离界线很近(远不到 BAND):平滑后的线没有跑出改判范围(改判范围外的像素本来就在线的正确一侧),色块的边就是这条线
        const dist = distanceToLines(lines, W, H, BAND + 1);
        let changed = 0;
        let far = 0;
        let beyond3 = 0;
        const nearWater = (k: number) => {
          const x = k % W;
          const y = (k - x) / W;
          for (let dy = -3; dy <= 3; dy++)
            for (let dx = -3; dx <= 3; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < W && yy < H && r.water[yy * W + xx] !== 0) return true;
            }
          return false;
        };
        for (let k = 0; k < W * H; k++) {
          if (base[k] === fixed[k]) continue;
          changed++;
          // 海岸边的像素最近的地块可能是水,"像素 → 州"是借邻块的,本来就可能不准,按线改判正好纠正它
          // (海岸断头接到岸线上的那一截线,穿过的正是这种离水稍远的借来的陆地)
          if (dist[k] >= 3 && (nearWater(k) || civ.regions.of[r.cell[k]] < 0)) continue;
          far = Math.max(far, dist[k]);
          if (dist[k] >= 3) beyond3++;
        }
        // 改判几乎全在 3 像素以内(手绘风的线多抖了一点,偶尔几个像素略远,但都在 BAND 以内)
        expect(far, `seed ${seed} ${style}:改判的像素离界线最远 ${far.toFixed(2)}`).toBeLessThan(BAND);
        expect(beyond3, `seed ${seed} ${style}`).toBeLessThanOrEqual(6);
        expect(changed).toBeGreaterThan(50);
        // 2. 线两侧各 1 像素处,色块正好是线左 / 右两侧的归属
        let ok = 0;
        let tried = 0;
        for (const l of lines) {
          const q = l.pts;
          for (let i = 2; i + 3 < q.length - 2; i += 6) {
            const ax = q[i];
            const ay = q[i + 1];
            const bx = q[i + 2];
            const by = q[i + 3];
            const len = Math.hypot(bx - ax, by - ay);
            if (len < 1e-3) continue;
            const mx = (ax + bx) / 2;
            const my = (ay + by) / 2;
            const nx = -(by - ay) / len;
            const ny = (bx - ax) / len;
            for (const [s, want] of [
              [1, l.left],
              [-1, l.right],
            ] as const) {
              const x = Math.floor(mx + s * nx);
              const y = Math.floor(my + s * ny);
              if (x < 0 || y < 0 || x >= W || y >= H || fixed[y * W + x] === -2) continue;
              tried++;
              if (fixed[y * W + x] === want) ok++;
            }
          }
        }
        expect(tried).toBeGreaterThan(200);
        expect(ok / tried, `seed ${seed} ${style}`).toBeGreaterThan(0.98);
      }
    }
  }, 60_000);

  it('海岸断头接到岸线上:网格的海岸外面多出来的陆地上也有线,大多数断头离水不到 1 个单位', () => {
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      const civ = civOf({ ...small, seed });
      const r = rasterize(w, 1);
      const W = r.w;
      const waterNear = (x: number, y: number) => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = (((Math.floor(x) + dx) % W) + W) % W;
            const yy = Math.floor(y) + dy;
            if (yy >= 0 && yy < r.h && r.water[yy * W + xx] !== 0) return true;
          }
        return false;
      };
      const p: CivDrawParams = { world: w, raster: r, civ, style: 'fantasy', year: civ.endYear, show: { ...CIV_SHOW_OFF, polities: true } };
      let n = 0;
      let ok = 0;
      for (const l of borderLines(p, Layer.Polity)) {
        const q = l.pts;
        const m = q.length / 2;
        for (const [flag, i] of [
          [l.end0, 0],
          [l.end1, m - 1],
        ] as const) {
          if (!flag) continue;
          n++;
          if (waterNear(q[i * 2], q[i * 2 + 1])) ok++;
        }
      }
      expect(n).toBeGreaterThan(20);
      // 只停在网格海岸三角形里时约三四成;接上以后七成左右(接不上的:先走进了别的陆地块,或者两个地块间距内没碰到水)
      expect(ok / n, `seed ${seed}`).toBeGreaterThan(0.6);
    }
  });

  it('界线由州界的链接成:每条线两侧归属不同,端点只落在三国交汇处或海岸', () => {
    const w = world({ ...small, seed: 7 });
    const civ = civOf({ ...small, seed: 7 });
    const rc = traceChains(w.mesh, civ.regions.of);
    // 链两侧的州确实相邻
    for (let c = 0; c < rc.count; c++) expect(rc.left[c]).not.toBe(rc.right[c]);
    const lines: SidedLine[] = mergeChains(rc, civ.polity);
    for (const l of lines) {
      expect(l.left).not.toBe(l.right);
      expect(l.pts.length).toBeGreaterThanOrEqual(4);
      if (l.closed) {
        expect(l.pts[0]).toBe(l.pts[l.pts.length - 2]);
        expect(l.pts[1]).toBe(l.pts[l.pts.length - 1]);
      }
    }
  });

  it('太冷 / 全是冰原的星球:没有城镇和国家,不报错', () => {
    const w = world({ ...small, seed: 7, temperature: -12 });
    const civ = generateCiv(w);
    for (const p of civ.polities) expect(civ.settlements[p.capital]).toBeDefined();
    const frozen: World = { ...w, biome: w.biome.map((b, i) => (w.water[i] === 0 ? Biome.Ice : b)) };
    const none = generateCiv(frozen);
    if (!none.viable) {
      expect(none.settlements).toEqual([]);
      expect(none.polities).toEqual([]);
      expect(Array.from(none.polity).every((v) => v === -1)).toBe(true);
    }
  });
});

/** 每个像素离最近的界线多远(只算 limit 以内,更远的记 Infinity) */
function distanceToLines(lines: SidedLine[], W: number, H: number, limit: number): Float32Array {
  const d = new Float32Array(W * H).fill(Infinity);
  // 主图东西相连:线的 x 是展开的(可能伸出左右边),左右各挪一整圈再量一遍
  for (const l of lines) for (const sh of [0, -W, W]) {
    const p = l.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] + sh;
      const ay = p[i + 1];
      const bx = p[i + 2] + sh;
      const by = p[i + 3];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-12;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - limit));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + limit));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - limit));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + limit));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          const v = Math.hypot(ax + dx * t - px, ay + dy * t - py);
          const k = y * W + x;
          if (v < d[k]) d[k] = v;
        }
      }
    }
  }
  return d;
}
