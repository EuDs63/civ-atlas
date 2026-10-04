import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNamer, NAME_KINDS, NAME_STYLES, type NameKind } from '../src/gen/names';
import { toneOf } from '../src/gen/names/eastern';
import { BLOCKLIST_FOR_TEST } from '../src/gen/names/filters';
import { ZH_LEN } from '../src/gen/names/spec';
import { transcribe } from '../src/gen/names/transcribe';

/**
 * 常用字表:GB2312 一级汉字(3755 个,标准里就叫"常用汉字"),用 Node 自带的 GBK 解码现场算出来。
 * 另外放行几个一级表外、但日常词里人人认识的字(雷霆、苍穹、翡翠、琥珀、晨曦、浩瀚、冥想、山岚)。
 */
function commonChars(): Set<string> {
  const dec = new TextDecoder('gbk');
  const set = new Set<string>();
  for (let hi = 0xb0; hi <= 0xd7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      if (hi === 0xd7 && lo > 0xf9) continue;
      set.add(dec.decode(new Uint8Array([hi, lo])));
    }
  }
  for (const c of '霆穹翡琥珀曦瀚冥岚') set.add(c);
  return set;
}
const COMMON = commonChars();

/** 每种风格 × 若干种子,每类各生成 n 个 */
function sample(n: number, seeds = [7, 2024, 1, 99]) {
  const out: Array<{ style: string; family: string; kind: NameKind; zh: string; latin?: string; generic?: string }> = [];
  for (const st of NAME_STYLES) {
    for (const seed of seeds) {
      const namer = createNamer(seed, st.id);
      for (let i = 0; i < n; i++) {
        for (const kind of NAME_KINDS) out.push({ style: st.id, family: st.family, kind, ...namer.name(kind) });
      }
    }
  }
  return out;
}
const SAMPLE = sample(40);

// 只防数量级退化(正常约 10–30 ms)。和其他测试文件并行跑、本机同时开着别的任务时单次计时会偶发尖峰,
// 所以每种语感连测三次取最快的一次;CI 机器慢,阈值再放宽
const budget = process.env.CI ? 200 : 100;

describe('地名生成器', () => {
  afterEach(() => vi.restoreAllMocks());

  it('至少 4 种西幻、2 种东方风格,id 不重复', () => {
    expect(NAME_STYLES.filter((s) => s.family === 'western').length).toBeGreaterThanOrEqual(4);
    expect(NAME_STYLES.filter((s) => s.family === 'eastern').length).toBeGreaterThanOrEqual(2);
    expect(new Set(NAME_STYLES.map((s) => s.id)).size).toBe(NAME_STYLES.length);
    for (const s of NAME_STYLES) expect(s.label).toMatch(/[一-鿿]/);
  });

  it('同 seed + 风格 + 调用顺序 → 同样的名字', () => {
    for (const st of NAME_STYLES) {
      const a = createNamer(123, st.id);
      const b = createNamer(123, st.id);
      for (let i = 0; i < 60; i++) {
        const kind = NAME_KINDS[i % NAME_KINDS.length];
        expect(a.name(kind)).toEqual(b.name(kind));
      }
    }
  });

  it('不同种子给出不同的名字', () => {
    for (const st of NAME_STYLES) {
      const a = createNamer(1, st.id);
      const b = createNamer(2, st.id);
      const xs = Array.from({ length: 10 }, () => a.name('city').zh);
      const ys = Array.from({ length: 10 }, () => b.name('city').zh);
      expect(xs).not.toEqual(ys);
    }
  });

  it('只用种子随机数,不碰 Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('不许用 Math.random');
    });
    for (const st of NAME_STYLES) {
      const n = createNamer(5, st.id);
      for (const kind of NAME_KINDS) n.name(kind);
    }
  });

  it('同一个 Namer 内不重名(各类混着要 300 个)', () => {
    for (const st of NAME_STYLES) {
      const namer = createNamer(31, st.id);
      const seen = new Set<string>();
      for (let i = 0; i < 300; i++) {
        const { zh } = namer.name(NAME_KINDS[i % NAME_KINDS.length]);
        expect(seen.has(zh), `${st.id} 重名:${zh}`).toBe(false);
        seen.add(zh);
      }
    }
  });

  it('要得再多也能返回且不重名(候选用完走兜底)', () => {
    const namer = createNamer(3, 'steppe');
    const seen = new Set<string>();
    for (let i = 0; i < 1500; i++) seen.add(namer.name('sea').zh);
    expect(seen.size).toBe(1500);
  });

  it('不含屏蔽字、屏蔽组合,也没有叠字', () => {
    const { chars, substr, exact } = BLOCKLIST_FOR_TEST;
    const bad: string[] = [];
    for (const x of SAMPLE) {
      for (const c of x.zh) if (chars.has(c)) bad.push(`${x.style} ${x.zh} 含屏蔽字 ${c}`);
      for (const s of substr) if (x.zh.includes(s)) bad.push(`${x.style} ${x.zh} 含 ${s}`);
      if (exact.has(x.zh)) bad.push(`${x.style} ${x.zh}`);
      if (/(.)\1/u.test(x.zh)) bad.push(`${x.style} ${x.zh} 有叠字`);
    }
    expect(bad).toEqual([]);
  });

  it('字数在范围内:国名 / 城名 2–5 字', () => {
    expect(ZH_LEN.state).toEqual([2, 5]);
    expect(ZH_LEN.city).toEqual([2, 5]);
    for (const x of SAMPLE) {
      const len = [...x.zh].length;
      const [lo, hi] = ZH_LEN[x.kind];
      expect(len, `${x.style}/${x.kind} ${x.zh}`).toBeGreaterThanOrEqual(lo);
      expect(len, `${x.style}/${x.kind} ${x.zh}`).toBeLessThanOrEqual(hi);
    }
  });

  it('每个字都在常用字表内', () => {
    for (const x of SAMPLE) {
      for (const c of x.zh) expect(COMMON.has(c), `${x.style} ${x.zh} 里的"${c}"不是常用字`).toBe(true);
    }
  });

  it('西幻风带拉丁原形,东方风不带;通名在名字末尾', () => {
    for (const x of SAMPLE) {
      if (x.family === 'western') expect(x.latin, `${x.style} ${x.zh}`).toMatch(/^[A-Z][A-Za-z' ’-]*$/);
      else expect(x.latin).toBeUndefined();
      if (x.generic) expect(x.zh.endsWith(x.generic), `${x.zh} / ${x.generic}`).toBe(true);
    }
  });

  it('东方风每个字都标了平仄,三字以上不会全是仄声', () => {
    for (const x of SAMPLE.filter((s) => s.family === 'eastern')) {
      const tones = [...x.zh].map((c) => toneOf(c));
      expect(tones.includes(undefined), `${x.zh} 有字没标平仄`).toBe(false);
      if (tones.length >= 3) expect(tones.every((t) => t === 'z'), `${x.zh} 全是仄声`).toBe(false);
    }
  });

  it('未知风格报错,并列出可选项', () => {
    expect(() => createNamer(1, 'klingon')).toThrow(/imperial/);
  });

  it(`生成 1000 个名字 < ${budget} 毫秒(三次取最快)`, () => {
    for (const st of NAME_STYLES) {
      createNamer(0, st.id).name('city'); // 预热
      let ms = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        const n = createNamer(42, st.id);
        for (let i = 0; i < 1000; i++) n.name(NAME_KINDS[i % NAME_KINDS.length]);
        ms = Math.min(ms, performance.now() - t0);
      }
      expect(ms, `${st.id} 最快一次用了 ${ms.toFixed(1)}ms`).toBeLessThan(budget);
    }
  });
});

describe('地名生成器 · 按键取名(名字按位置取)', () => {
  it('同 seed + 风格 + 种类 + 键 → 同一串候选,和调用先后、别的键、逐个取名都无关', () => {
    for (const st of NAME_STYLES) {
      const a = createNamer(123, st.id);
      const b = createNamer(123, st.id);
      // b 先乱取一通:逐个取名、别的键
      for (let i = 0; i < 30; i++) b.name(NAME_KINDS[i % NAME_KINDS.length]);
      for (let k = 999; k > 900; k--) b.keyed('city', k)();
      for (const kind of NAME_KINDS) {
        for (const key of [0, 1, 4567, 35999]) {
          const x = a.keyed(kind, key);
          const y = b.keyed(kind, key);
          for (let t = 0; t < 5; t++) expect(y(), `${st.id} ${kind} ${key}`).toEqual(x());
        }
      }
      // 键的每一位都算数;种类不同、种子不同也不同
      const first = (n: ReturnType<typeof createNamer>, kind: NameKind, ...key: number[]) => n.keyed(kind, ...key)().zh;
      const diff = (xs: string[]) => new Set(xs).size;
      expect(diff([0, 1, 2, 3, 4, 5, 6, 7].map((k) => first(a, 'city', 4567, k)))).toBeGreaterThan(4);
      expect(diff([0, 1, 2, 3, 4, 5, 6, 7].map((k) => first(a, 'city', k)))).toBeGreaterThan(4);
      expect(diff([1, 2, 3, 4, 5, 6, 7, 8].map((s) => first(createNamer(s, st.id), 'city', 4567)))).toBeGreaterThan(4);
    }
  });

  it('候选都合格(字数、屏蔽字;西幻带拉丁原形);按键取名不影响逐个取名', () => {
    const { chars, substr, exact } = BLOCKLIST_FOR_TEST;
    for (const st of NAME_STYLES) {
      const n = createNamer(7, st.id);
      for (const kind of NAME_KINDS) {
        for (let key = 0; key < 40; key++) {
          const g = n.keyed(kind, key * 131)();
          const len = [...g.zh].length;
          expect(len, g.zh).toBeGreaterThanOrEqual(ZH_LEN[kind][0]);
          expect(len, g.zh).toBeLessThanOrEqual(ZH_LEN[kind][1]);
          for (const c of g.zh) expect(chars.has(c), `${g.zh} 含屏蔽字 ${c}`).toBe(false);
          for (const w of substr) expect(g.zh.includes(w), `${g.zh} 含 ${w}`).toBe(false);
          expect(exact.has(g.zh), g.zh).toBe(false);
          if (st.family === 'western') expect(g.latin, g.zh).toBeTruthy();
          else expect(g.latin).toBeUndefined();
        }
      }
      // 按键取名不占逐个取名的"不重名"名额:两个同种子的 Namer,一个先按键取过名,逐个取出来的还是一样
      const p = createNamer(9, st.id);
      const q = createNamer(9, st.id);
      for (let k = 0; k < 50; k++) q.keyed('city', k)();
      for (let i = 0; i < 20; i++) expect(q.name('city')).toEqual(p.name('city'));
    }
  });

  it('一直取总能取到没用过的(候选用完给带前缀 / 序号的兜底名,也不重复)', () => {
    const n = createNamer(3, 'steppe');
    const next = n.keyed('state', 42);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(next().zh);
    // 前几十个是正常候选(可能有重复),之后的兜底名互不相同
    expect(seen.size).toBeGreaterThan(200);
  });

  it(`按键取 1000 个名字 < ${budget} 毫秒(字库复用,每个键只多一个随机数发生器)`, () => {
    for (const st of NAME_STYLES) {
      let ms = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        const n = createNamer(42, st.id);
        for (let i = 0; i < 1000; i++) n.keyed(NAME_KINDS[i % NAME_KINDS.length], i * 37)();
        ms = Math.min(ms, performance.now() - t0);
      }
      expect(ms, `${st.id} 最快一次用了 ${ms.toFixed(1)}ms`).toBeLessThan(budget);
    }
  });
});

/**
 * 旧版东方风曾经从"真实名字清单"里整块取名(古国号、朝代名、历史地区、名川、《山海经》原条目),
 * 现在改成字库按规则组合。这里列出旧清单能拼出的那些真实名字:新版允许偶尔巧合撞上(比如按"地理通名 + 方位"拼出河东),
 * 但不许再成批、频繁地出现。
 */
const cross = (as: string, gs: string[]) => [...as].flatMap((a) => gs.map((g) => a + g));
const withSuffix = (ws: string, gs: string[]) => ws.split(/\s+/).flatMap((w) => gs.map((g) => w + g));
const REMOVED_REAL = new Set<string>([
  // 中原国号:方位 / 后 + 古国(北燕、后蜀、西楚)、大 + 古国(大魏)、周代封国(许国)
  ...[...'北南东西后'].flatMap((d) => [...'燕楚齐梁越吴蜀晋卫魏赵周凉夏'].map((s) => d + s)),
  ...[...'燕楚齐梁陈越晋魏赵周夏'].map((s) => '大' + s),
  ...cross('许蔡曹邓申随巴徐虞殷邢薛纪卫郑鲁陈越吴', ['国']),
  // 中原城名 / 河名:兰陵、竟陵、剑门、孟津、汾阳、咸阳、洛水、渭水
  ...cross('江广兰武巴竟零延海', ['陵']),
  ...cross('雁剑玉虎金龙天石铁', ['门']),
  '孟津',
  ...cross('汾洛渭淮汝济衡华霍首晋咸益信', ['阳']),
  ...cross('洛漳沂汝湘淄潍沁滦易漓渭汾', ['水']),
  '瀚海', '翰海',
  // 历史地区(中原 / 边塞):河东、陇右、辽东、朔方……
  ...withSuffix(
    '河东 河西 河外 河中 关中 关内 关外 关西 江左 江右 江北 陇右 陇西 陇东 淮南 淮北 淮西 岭南 岭北 辽东 辽西 汉中 海东 海西 燕北 燕南 山南 漠北 漠南 朔方',
    ['', '道', '郡', '府'],
  ),
  // 仙侠:真实山名、名胜
  ...withSuffix('太白 天柱 玉京 灵山 寒山 孤山', ['山', '峰', '岭', '崖', '城', '镇', '关', '江', '河', '川', '溪', '水']),
  ...withSuffix('云梦 兰亭 雨花 沧浪 太虚', ['城', '镇', '关', '渡', '山', '峰', '岭', '海', '江', '河', '川', '溪', '水', '原', '泽', '谷', '林', '洲']),
  // 边塞
  '弱水', '飞狐河',
  // 山海经 / 庄子 / 列子 原条目
  ...withSuffix('轩辕 司幽 淑士 中容 君子 丈夫 周饶 肃慎 青丘 白民', ['国']),
  ...[...'熊巢苏易施虞崇洛容'].map((s) => '有' + s),
  ...withSuffix('大荒 若木 扶桑 汤谷 羽渊 昆仑 不周 鸿蒙 玄冥 苍梧', ['之海', '之渊']),
  ...withSuffix('大荒 都广 常羊 寿华 大乐 流黄 司幽 汤谷', ['之野']),
  ...cross('弱洋英若汤漆洛', ['水']),
  '北冥', '南冥', '归墟', '虞渊', '羽渊', '钟山', '英山', '浮山', '幽都', '帝台',
]);

describe('东方风不再照搬真实名字清单', () => {
  const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
  const PER_KIND = 20;

  for (const st of NAME_STYLES.filter((s) => s.family === 'eastern')) {
    it(`${st.id}:旧清单里的真实名字只是偶尔巧合出现`, () => {
      let total = 0;
      let hits = 0;
      const seedsOf = new Map<string, number>();
      for (const seed of SEEDS) {
        const namer = createNamer(seed, st.id);
        const inThisSeed = new Set<string>();
        for (let i = 0; i < PER_KIND; i++) {
          for (const kind of NAME_KINDS) {
            const { zh } = namer.name(kind);
            total++;
            if (REMOVED_REAL.has(zh)) {
              hits++;
              inThisSeed.add(zh);
            }
          }
        }
        for (const zh of inThisSeed) seedsOf.set(zh, (seedsOf.get(zh) ?? 0) + 1);
      }
      // 旧版:中原 29%、山海 19%、边塞 4.9%、仙侠 4.8%;新版都在 2% 以下
      expect(hits / total, `${st.id} 撞上旧清单 ${hits}/${total}`).toBeLessThan(0.025);
      // 单个名字(比如"后蜀""大魏""轩辕国")不能在大多数世界里都出现:50 个种子里最多 15 个(旧版"瀚海"50 个都有)
      const frequent = [...seedsOf].filter(([, n]) => n > 15).map(([zh, n]) => `${zh}×${n}`);
      expect(frequent, `${st.id} 频繁出现的旧名字`).toEqual([]);
    });
  }
});

describe('译音', () => {
  it.each([
    ['Aldoria', '阿尔多里亚'],
    ['Velona', '维洛纳'],
    ['Castevel', '卡斯特维尔'],
    ['Kotuvo', '科图沃'],
    ['Tengri', '腾格里'],
    ['Leon', '莱昂'],
    ['Adrian', '阿德里安'],
    ['Talirah', '塔利拉'],
    ['Bahr', '巴赫尔'],
    ['Streva', '斯特雷瓦'],
    ['Anna', '安纳'],
    ['Merots', '梅罗茨'],
  ])('%s → %s', (latin, zh) => {
    expect(transcribe(latin)).toBe(zh);
  });

  it('风格可以覆盖音节表(斯拉夫:Beloslav → 别洛斯拉夫;北欧:j 读 y)', () => {
    expect(transcribe('Beloslav', { table: { be: '别' } })).toBe('别洛斯拉夫');
    expect(transcribe('Jotun', { jAsY: true })).toBe('约通');
  });
});
