/**
 * 地图文字的字体:构建时按字表裁剪好的子集(public/fonts/,由 scripts/subset-fonts.ts 生成),自己托管。
 *
 *   手绘风  霞鹜文楷 GB(LXGW WenKai GB,SIL OFL 1.1)   CSS 字体名 "LXGW WenKai"
 *   写实风  思源宋体 Google 版(Noto Serif SC,SIL OFL 1.1) CSS 字体名 "Noto Serif SC"
 *
 * canvas 的坑:fillText 会触发字体下载,但第一次画出来的是默认字体,下载完也不会自动重画。
 * 所以画字前一律先 await ensureFonts(...),确保要用的字都已经加载好。
 */

/** 手绘风字体名(国名、城名也用它) */
export const FONT_FANTASY = 'LXGW WenKai';
/** 写实风字体名 */
export const FONT_REALISTIC = 'Noto Serif SC';

/** 子集文件缺字或加载失败时的后备(系统自带的楷体 / 宋体) */
const FALLBACK: Record<string, string> = {
  [FONT_FANTASY]: '"Kaiti SC", "STKaiti", "KaiTi", "BiauKai", serif',
  [FONT_REALISTIC]: '"Songti SC", "STSong", "SimSun", serif',
};

interface FontFile {
  family: string;
  weight: number;
  file: string;
}

/** 与 scripts/subset-fonts.ts 的输出一一对应 */
export const FONT_FILES: FontFile[] = [
  { family: FONT_FANTASY, weight: 500, file: 'lxgw-wenkai-gb-500.woff2' },
  { family: FONT_REALISTIC, weight: 500, file: 'noto-serif-sc-500.woff2' },
  { family: FONT_REALISTIC, weight: 700, file: 'noto-serif-sc-700.woff2' },
];

export type LabelStyle = 'fantasy' | 'realistic' | 'data';

export function familyFor(style: LabelStyle): string {
  return style === 'fantasy' ? FONT_FANTASY : FONT_REALISTIC;
}

/** canvas 的 font 字符串,如 `500 14px "LXGW WenKai", "Kaiti SC", …` */
export function fontCss(family: string, weight: number, px: number): string {
  return `${weight} ${px.toFixed(2)}px "${family}", ${FALLBACK[family] ?? 'serif'}`;
}

let registered = false;

/** 把字体文件登记到 document.fonts(只登记,不下载;真正下载在第一次 load 时) */
export function registerFonts(): void {
  if (registered || typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  registered = true;
  const base = import.meta.env.BASE_URL ?? './';
  for (const f of FONT_FILES) {
    const url = new URL(`${base}fonts/${f.file}`, document.baseURI).href;
    const face = new FontFace(f.family, `url("${url}") format("woff2")`, { weight: String(f.weight), style: 'normal', display: 'block' });
    document.fonts.add(face);
  }
}

/** 页面一打开就开始下载所有字体(两种画风一共几百 KB),切画风时不用再等 */
export function preloadFonts(): void {
  registerFonts();
  if (typeof document === 'undefined' || !document.fonts) return;
  for (const f of FONT_FILES) void document.fonts.load(fontCss(f.family, f.weight, 16), '海').catch(() => {});
}

const ready = new Set<string>();

/**
 * 等某种画风要用的字体(所有字重)把 text 里的字都加载好。
 * 失败或超时(网络断了)也会返回,调用方照常画:那时浏览器会用后备字体。
 */
export async function ensureFonts(style: LabelStyle, text: string, timeoutMs = 8000): Promise<boolean> {
  registerFonts();
  if (typeof document === 'undefined' || !document.fonts) return false;
  const family = familyFor(style);
  const key = `${family}|${text}`;
  if (ready.has(key)) return true;
  const loads = FONT_FILES.filter((f) => f.family === family).map((f) => document.fonts.load(fontCss(f.family, f.weight, 16), text || '海'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((res) => (timer = setTimeout(() => res('timeout'), timeoutMs)));
  try {
    const r = await Promise.race([Promise.all(loads), timeout]);
    if (r === 'timeout') return false;
    ready.add(key);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 字体是否已经就绪(同步查询;字多时 document.fonts.check 要逐字查,查过就绪的记下,不再查) */
export function fontsReady(style: LabelStyle, text = '海'): boolean {
  if (typeof document === 'undefined' || !document.fonts) return false;
  const family = familyFor(style);
  const key = `${family}|${text}`;
  if (ready.has(key)) return true;
  const ok = FONT_FILES.filter((f) => f.family === family).every((f) => document.fonts.check(fontCss(f.family, f.weight, 16), text));
  if (ok) ready.add(key);
  return ok;
}
