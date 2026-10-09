/**
 * 地名样品:每种语感各生成一批国名 / 城名 / 山名 / 海名 / 河名 / 地区名。
 *
 *   npx tsx scripts/names-demo.ts                    # 终端里看(默认 seed=7,每类 20 个)
 *   npx tsx scripts/names-demo.ts --seed 2024 --n 12
 *   npx tsx scripts/names-demo.ts --style nordic     # 只看一种
 *   npx tsx scripts/names-demo.ts --md snaps/names-samples.md  # 写成 Markdown 样品表
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNamer, NAME_STYLES, type GeneratedName, type NameKind } from '../src/gen/names';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = Number(opt('--seed') ?? 7);
const n = Number(opt('--n') ?? 20);
const only = opt('--style');
const mdPath = opt('--md');

const KINDS: Array<[NameKind, string, number]> = [
  ['state', '国名', n],
  ['city', '城名', n],
  ['mountain', '山脉', n],
  ['sea', '海洋', n],
  ['river', '河流', n],
  ['region', '地区', Math.ceil(n / 2)],
];

const styles = NAME_STYLES.filter((s) => !only || s.id === only);
const overview: string[] = [];
const sections: string[] = [];

for (const st of styles) {
  const namer = createNamer(seed, st.id);
  const cols: GeneratedName[][] = KINDS.map(([kind, , count]) => Array.from({ length: count }, () => namer.name(kind)));

  console.log(`\n== ${st.label}  [${st.id}]  ${st.desc}`);
  KINDS.forEach(([, label], i) => console.log(`  ${label}:${cols[i].map((x) => x.zh).join('、')}`));

  overview.push(`| ${st.label} | ${cols.slice(0, 5).map((c) => c.slice(0, 3).map((x) => x.zh).join('、')).join(' | ')} |`);
  const cell = (x?: GeneratedName) => (!x ? '' : x.latin ? `${x.zh} <sub>${x.latin}</sub>` : x.zh);
  const rows = Math.max(...cols.map((c) => c.length));
  sections.push('', `## ${st.label} \`${st.id}\``, '', st.desc, '');
  sections.push('| # | ' + KINDS.map(([, l]) => l).join(' | ') + ' |', '|---|' + KINDS.map(() => '---').join('|') + '|');
  for (let r = 0; r < rows; r++) sections.push(`| ${r + 1} | ` + cols.map((c) => cell(c[r])).join(' | ') + ' |');
}

if (mdPath) {
  const west = NAME_STYLES.filter((s) => s.family === 'western').length;
  const east = NAME_STYLES.length - west;
  const doc = [
    '# 地名生成器样品',
    '',
    `> 由 \`npx tsx scripts/names-demo.ts --seed ${seed} --n ${n} --md ${mdPath}\` 生成,同一个种子每次结果一样。`,
    `> 共 ${NAME_STYLES.length} 种语感:western ${west} 种(原西幻 → 汉籍西域译名式汉字),东方 ${east} 种(中原 / 仙侠 / 边塞 / 山海,意象字 + 通名,照顾平仄)。`,
    '',
    '## 一眼总览(每类前 3 个)',
    '',
    '| 风格 | 国名 | 城名 | 山脉 | 海洋 | 河流 |',
    '|---|---|---|---|---|---|',
    ...overview,
    ...sections,
    '',
  ];
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, doc.join('\n'));
  console.log(`\n已写入 ${mdPath}`);
}
