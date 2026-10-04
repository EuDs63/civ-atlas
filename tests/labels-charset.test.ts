/**
 * 地图文字的字表覆盖:地名生成器可能用到的每个字,都必须在裁剪后的字体子集里。
 * 缺字时重跑 `npx tsx scripts/subset-fonts.ts`(会下载字体源文件,按新字表重新裁剪)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { labelCharset } from '../scripts/lib/charset';
import { woff2Chars } from '../scripts/lib/woff2';
import { createNamer, NAME_KINDS, NAME_STYLES } from '../src/gen/names';
import { FONT_FILES } from '../src/render/labels/fonts';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import { easternTitles, POLITY_FORMS, polityAllTitles, polityRoots } from '../src/gen/civ/growth';

const FONT_DIR = path.join('public', 'fonts');
const CHARSET = new Set(labelCharset());

describe('地图文字的字体子集', () => {
  it('字体文件都在,总大小 ≤ 1 MB,附带 OFL 许可证', () => {
    let total = 0;
    for (const f of FONT_FILES) {
      const p = path.join(FONT_DIR, f.file);
      expect(fs.existsSync(p), `缺字体文件 ${p}`).toBe(true);
      total += fs.statSync(p).size;
    }
    expect(total).toBeLessThanOrEqual(1024 * 1024);
    const licenses = fs.readdirSync(FONT_DIR).filter((f) => f.startsWith('OFL'));
    expect(licenses.length).toBeGreaterThanOrEqual(2);
    for (const l of licenses) expect(fs.readFileSync(path.join(FONT_DIR, l), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('字表里的每个字都在每个字体子集里', () => {
    expect(CHARSET.size).toBeGreaterThan(500);
    for (const f of FONT_FILES) {
      const has = woff2Chars(fs.readFileSync(path.join(FONT_DIR, f.file)));
      const missing = [...CHARSET].filter((c) => !has.has(c));
      expect(missing.join(''), `${f.file} 缺字(重跑 npx tsx scripts/subset-fonts.ts)`).toBe('');
    }
  });

  it('地名生成器实际生成的名字(12 种语感 × 6 类 × 多个种子)都在字表里', () => {
    const missing = new Set<string>();
    for (const st of NAME_STYLES) {
      for (const seed of [1, 7, 2024, 99, 123456]) {
        const namer = createNamer(seed, st.id);
        for (let i = 0; i < 120; i++) {
          for (const kind of NAME_KINDS) for (const c of namer.name(kind).zh) if (!CHARSET.has(c)) missing.add(c);
        }
      }
    }
    expect([...missing].join('')).toBe('');
  });

  it('地理实体的名字(海、山、河、湖、岛、荒漠)、国名(历朝各档国号的全称和简称)、城名都在字表里', () => {
    const missing = new Set<string>();
    let renamed = 0;
    for (const seed of [7, 2024, 3, 99]) {
      const w = generateWorld({ ...DEFAULT_PARAMS, cells: 12000, seed });
      const civ = generateCiv(w);
      expect(civ.places.length).toBeGreaterThan(5);
      expect(civ.polities.length).toBeGreaterThan(3);
      const texts = [...civ.places.map((p) => p.name), ...civ.settlements.map((s) => s.name)];
      // 改朝换代后的国号(阶段 3 王朝更替)也在内
      renamed += civ.polities.filter((p) => polityRoots(p).length > 1).length;
      for (const p of civ.polities) texts.push(...polityAllTitles(p));
      for (const t of texts) for (const c of t) if (!CHARSET.has(c)) missing.add(c);
    }
    expect(renamed).toBeGreaterThan(0);
    expect([...missing].join('')).toBe('');
  });

  it('两套国号形态表(西幻、东方)用到的字都在字表里', () => {
    const missing = new Set<string>();
    const lineages = ['realm', 'khanate', 'republic'] as const;
    for (const l of lineages) {
      for (const f of POLITY_FORMS[l]) for (const c of f) if (!CHARSET.has(c)) missing.add(c);
      for (const root of ['昌', '大安', '景辰']) for (const t of easternTitles(root, l)) for (const c of t) if (!CHARSET.has(c)) missing.add(c);
    }
    for (const c of '部汗邦共和帝王朝皇国大') if (!CHARSET.has(c)) missing.add(c);
    expect([...missing].join('')).toBe('');
  });
});
