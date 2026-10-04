/**
 * 地图文字的字表:地名生成器 + 地理通名可能用到的每一个汉字。字体按它裁剪(scripts/subset-fonts.ts),
 * 单测按它检查字体子集是否齐全(tests/labels-charset.test.ts)。
 *
 * 做法:把下面这些源文件里**所有字符串字面量**中的汉字收集起来(不看注释)。
 * 地名都是从这些字面量里的字拼出来的(字库、音译表、通名、兜底前缀、中文数字……),所以这是一个上界:
 * 生成器改了字库、加了新字,重新跑 `npx tsx scripts/subset-fonts.ts` 就能跟上;忘了跑,单测会报出缺哪些字。
 *
 * 国号形态表(西幻 / 东方两套)在 src/gen/civ/growth.ts;城名由地名生成器起,已经在 src/gen/names 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** 收字的源文件 / 目录(相对仓库根目录;目录收其中所有 .ts) */
export const CHARSET_SOURCES = [
  'src/gen/names', // 地名生成器:字库、音译表、通名
  'src/gen/civ/places.ts', // 地理实体:海洋的中性叫法、湖 / 岛 / 沙漠 / 荒原
  'src/render/civ/labels.ts', // 文字层的数据来源(国名、城名也在这里接)
  'src/gen/civ/growth.ts', // 国号形态表:部、国、王国、帝国、汗国、城邦、共和国;东方的大 X、王朝、皇朝
];

/** 不收的文件:屏蔽字表里的字恰恰是不会出现在地名里的;人名只在编年史、面板里出现(界面字体),不上地图 */
const EXCLUDE = new Set(['src/gen/names/filters.ts', 'src/gen/names/persons.ts']);

/**
 * 额外的字:国号、行政与聚落通名(先放进来,免得以后每用到一个新字就重裁一次字体),
 * 方位、数字和地图上常见的几个标点。
 */
export const EXTRA_CHARS =
  '国王帝皇汗公侯伯子男部盟邦联共和朝府州郡县道省城镇村寨堡港关都京邑乡里营屯驿' +
  '东南西北中上下前后内外大小新旧高低' +
  '一二三四五六七八九十百千万零' +
  '海洋湾峡岛屿群礁半岬角河江湖泽泊溪川水源山岭峰脉原野漠沙荒林谷滩' +
  '0123456789·—';

const isHan = (c: string) => /\p{Script=Han}/u.test(c);

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const rel of CHARSET_SOURCES) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) if (f.endsWith('.ts')) out.push(path.join(rel, f));
    } else out.push(rel);
  }
  return out.filter((f) => !EXCLUDE.has(f.split(path.sep).join('/')));
}

/** 一个源文件里所有字符串字面量(含模板字符串的静态部分)中的汉字 */
function hanInLiterals(file: string, src: string, into: Set<string>) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false);
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      for (const c of n.text) if (isHan(c)) into.add(c);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** 字表(去重、按码位排序的字符串) */
export function labelCharset(root = process.cwd()): string {
  const set = new Set<string>();
  for (const f of sourceFiles(root)) hanInLiterals(f, fs.readFileSync(path.join(root, f), 'utf8'), set);
  for (const c of EXTRA_CHARS) set.add(c);
  return [...set].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!).join('');
}
