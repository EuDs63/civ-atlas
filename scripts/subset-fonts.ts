/**
 * 按地图文字的字表裁剪中文字体,输出 WOFF2 到 public/fonts/(和许可证一起提交进仓库)。
 *
 *   npx tsx scripts/subset-fonts.ts
 *
 * 什么时候要重跑:地名生成器 / 地理通名加了新字(tests/labels-charset.test.ts 会报出缺哪些字)。
 *
 * 字体源文件从官方发布处下载(固定版本 + SHA-256 校验),缓存在 node_modules/.cache/civ-atlas-fonts/,不进仓库:
 *   霞鹜文楷 GB  lxgw/LxgwWenkaiGB 的 GitHub Release v1.522,LXGWWenKaiGB-Medium.ttf(SIL OFL 1.1)
 *   Noto Serif SC  google/fonts 仓库(固定提交)里的 NotoSerifSC[wght].ttf,版本 2.003(SIL OFL 1.1),
 *                  可变字重,裁剪时固定成 500 和 700 两个字重
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import subsetFont from 'subset-font';
import { labelCharset } from './lib/charset';
import { woff2Chars, woff2Name } from './lib/woff2';

const LXGW_TAG = 'v1.522';
const GF_COMMIT = '2e61f4355afd22b801791b0df176065082423b87';

interface Source {
  file: string;
  url: string;
  sha256: string;
}

const SOURCES: Record<string, Source> = {
  lxgw: {
    file: 'LXGWWenKaiGB-Medium.ttf',
    url: `https://github.com/lxgw/LxgwWenkaiGB/releases/download/${LXGW_TAG}/LXGWWenKaiGB-Medium.ttf`,
    sha256: 'b885c51ec0d3f325974013801dfcefda1a9ba0bf385c607cf5f2582dafa2e5ab',
  },
  noto: {
    file: 'NotoSerifSC[wght].ttf',
    url: `https://raw.githubusercontent.com/google/fonts/${GF_COMMIT}/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf`,
    sha256: '050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9',
  },
};

/** Noto CJK 上游仓库(google/fonts 里这款字体的来源提交,见其 upstream_info.md) */
const NOTO_CJK_COMMIT = '985fa52c81c1d6692ccdd82bc3656e8fb932fd89';

/**
 * 许可证全文。霞鹜文楷的 OFL.txt 自带版权行;Noto 上游的 LICENSE 只有 OFL 正文,
 * 版权行从字体文件里读出来补在最前面(fromFont)。
 */
const LICENSES: { out: string; url: string; fromFont?: string }[] = [
  {
    out: 'OFL-LXGW-WenKai-GB.txt',
    url: `https://raw.githubusercontent.com/lxgw/LxgwWenkaiGB/${LXGW_TAG}/OFL.txt`,
  },
  {
    out: 'OFL-Noto-Serif-SC.txt',
    url: `https://raw.githubusercontent.com/notofonts/noto-cjk/${NOTO_CJK_COMMIT}/Serif/LICENSE`,
    fromFont: 'noto-serif-sc-500.woff2',
  },
];

/** 输出文件:和 src/render/labels/fonts.ts 的 FONT_FILES 一一对应 */
const OUTPUTS: { out: string; src: keyof typeof SOURCES; wght?: number; label: string }[] = [
  { out: 'lxgw-wenkai-gb-500.woff2', src: 'lxgw', label: '霞鹜文楷 GB Medium' },
  { out: 'noto-serif-sc-500.woff2', src: 'noto', wght: 500, label: 'Noto Serif SC Medium(500)' },
  { out: 'noto-serif-sc-700.woff2', src: 'noto', wght: 700, label: 'Noto Serif SC Bold(700)' },
];

const CACHE = path.join('node_modules', '.cache', 'civ-atlas-fonts');
const OUT_DIR = path.join('public', 'fonts');
/** 所有子集加起来不超过 1 MB */
const BUDGET = 1024 * 1024;

async function download(url: string, dest: string): Promise<void> {
  process.stdout.write(`下载 ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function source(key: keyof typeof SOURCES): Promise<Buffer> {
  const s = SOURCES[key];
  fs.mkdirSync(CACHE, { recursive: true });
  const p = path.join(CACHE, s.file);
  if (!fs.existsSync(p)) await download(s.url, p);
  const buf = fs.readFileSync(p);
  const h = sha256(buf);
  if (s.sha256 && h !== s.sha256) throw new Error(`${s.file} 校验不对:${h}(应为 ${s.sha256})。删掉 ${p} 重新下载`);
  if (!s.sha256) console.log(`  ${s.file} sha256 = ${h}`);
  return buf;
}

const charset = labelCharset();
// 空格 + 常用标点(万一地名里出现),不算进字表检查
const text = charset + ' ';
console.log(`字表 ${[...charset].length} 个字符`);

fs.mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
const notes: string[] = [];
for (const o of OUTPUTS) {
  const src = await source(o.src);
  const out = await subsetFont(src, text, {
    targetFormat: 'woff2',
    noHinting: true,
    // 逐字画,不需要连字、竖排替换、字距等排版特性
    keepFeatures: [],
    // 保留版权、字体名、许可证说明
    preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 13, 14],
    ...(o.wght ? { variationAxes: { wght: o.wght } } : {}),
  });
  const has = woff2Chars(out);
  const missing = [...charset].filter((c) => !has.has(c));
  if (missing.length) console.warn(`  ⚠ ${o.label} 缺 ${missing.length} 个字:${missing.join('')}`);
  fs.writeFileSync(path.join(OUT_DIR, o.out), out);
  total += out.length;
  const copyright = woff2Name(out, 0) ?? '';
  console.log(`  ${o.out}  ${(out.length / 1024).toFixed(1)} KB  (${has.size} 个字符)`);
  notes.push(`${o.out}\n  ${o.label}\n  来源:${SOURCES[o.src].url}\n  sha256(源文件):${sha256(src)}\n  字体内的版权声明:${copyright}`);
}

for (const l of LICENSES) {
  const res = await fetch(l.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`许可证下载失败 ${res.status} ${l.url}`);
  let body = await res.text();
  if (l.fromFont) {
    const c = woff2Name(fs.readFileSync(path.join(OUT_DIR, l.fromFont)), 0);
    if (c) body = `${c}\n\n${body}`;
  }
  fs.writeFileSync(path.join(OUT_DIR, l.out), body);
}

fs.writeFileSync(
  path.join(OUT_DIR, 'SOURCES.txt'),
  [
    '地图文字用的字体子集(由 scripts/subset-fonts.ts 生成,按地名字表裁剪,请勿手改)。',
    '两款字体都以 SIL Open Font License 1.1 授权,许可证全文见同目录的 OFL-*.txt。',
    '霞鹜文楷的许可证附加条款允许为网页字体裁剪 / 转换成 WOFF2 后沿用原名。',
    '',
    ...notes,
    '',
  ].join('\n'),
);

console.log(`合计 ${(total / 1024).toFixed(1)} KB(预算 ${BUDGET / 1024} KB)`);
if (total > BUDGET) {
  console.error('超出预算!');
  process.exitCode = 1;
}
