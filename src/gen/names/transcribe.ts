/**
 * 拉丁字母 → 中文译音。
 *
 * 参照新华社外国地名译名的习惯:
 * - 辅音 + 元音合成一个字(la 拉、do 多、ri 里)
 * - 元音后的 n / ng 并进前一个字(an 安、lin 林、don 东)
 * - 元音后的 l / r 单独写成"尔"(Al → 阿尔)
 * - 其余不带元音的辅音单独成字(s 斯、t 特、d 德、k 克)
 * - 辅音后接 ia / ea 时 a 读"亚"(ria 里亚、nia 尼亚)
 * 例:Aldoria → 阿尔多里亚,Casteville → 卡斯特维尔(-ville 由调用方给定)。
 *
 * 只处理本生成器自己拼出来的拉丁字母串;不认识的字母会抛错(单测会兜住)。
 */

/** 每个声母对应一行:a e i o u ai au an en in on un ang ong */
const COLS = ['a', 'e', 'i', 'o', 'u', 'ai', 'au', 'an', 'en', 'in', 'on', 'un', 'ang', 'ong'] as const;

const BASE_ROWS: Record<string, string> = {
  '': '阿埃伊奥乌艾奥安恩因翁温昂翁',
  b: '巴贝比博布拜鲍班本宾邦本邦邦',
  p: '帕佩皮波普派保潘彭平庞彭庞蓬',
  d: '达德迪多杜代道丹登丁东敦当东',
  t: '塔特提托图泰陶坦腾廷通通唐通',
  g: '加格吉戈古盖高甘根金贡贡冈贡',
  k: '卡克基科库凯考坎肯金孔昆康孔',
  f: '法费菲福富法福凡芬芬丰丰方丰',
  v: '瓦维维沃武瓦沃万文文冯文旺冯',
  s: '萨塞西索苏赛绍桑森辛松孙桑松',
  z: '扎泽齐佐祖载佐赞曾津宗尊赞宗',
  sh: '沙谢希肖舒夏绍尚申欣雄顺尚雄',
  ch: '查切奇乔丘柴乔钱琴钦琼春昌琼',
  j: '贾杰吉乔朱贾乔詹珍金琼君江琼',
  m: '马梅米莫穆迈茂曼门明蒙蒙芒蒙',
  n: '纳内尼诺努奈诺南嫩宁农农南农',
  l: '拉莱利洛卢莱劳兰伦林隆伦朗隆',
  r: '拉雷里罗鲁莱劳兰伦林龙伦朗龙',
  h: '哈赫希霍胡海豪汉亨欣洪洪杭洪',
  th: '萨塞西索苏赛陶桑森辛松孙桑松',
  kh: '哈赫希霍胡海豪汗亨欣洪浑杭洪',
  y: '亚耶伊约尤亚尧扬延因永云扬永',
  w: '瓦韦威沃伍怀沃万温温翁温旺翁',
  ts: '察采齐措楚蔡曹灿曾津聪村仓聪',
};
BASE_ROWS.gh = BASE_ROWS.g;
BASE_ROWS.dh = BASE_ROWS.z;

/** 不带元音的辅音单独成字 */
const BASE_LONE: Record<string, string> = {
  b: '布', p: '普', d: '德', t: '特', g: '格', k: '克', f: '夫', v: '夫',
  s: '斯', z: '兹', sh: '什', ch: '奇', j: '吉', m: '姆', n: '恩', l: '尔',
  r: '尔', h: '赫', th: '斯', kh: '赫', gh: '格', dh: '德', y: '伊', w: '乌', ts: '茨',
};

function buildTable(): Map<string, string> {
  const t = new Map<string, string>();
  for (const [onset, row] of Object.entries(BASE_ROWS)) {
    const chars = [...row];
    if (chars.length !== COLS.length) throw new Error(`译音表 ${onset || '零声母'} 行长度不对`);
    COLS.forEach((v, i) => t.set(onset + v, chars[i]));
  }
  return t;
}
const BASE = buildTable();

export interface TranscribeOptions {
  /** j 读 /dʒ/(英语、阿拉伯,默认)还是 /j/(北欧、斯拉夫:Jor → 约尔) */
  jAsY?: boolean;
  /** 覆盖音节表,键是"声母+韵母"(如 re、ka、lan),或"-辅音"表示单独成字(如 -v) */
  table?: Record<string, string>;
}

type Tok = { c: string } | { v: string };

const VOWEL_RE = /[aeiouy]/;
const DIPH: Record<string, string> = { ai: 'ai', ay: 'ai', ae: 'ai', ei: 'ai', ey: 'ai', au: 'au', aw: 'au', ou: 'u', oo: 'u', ee: 'i', aa: 'a' };

/** 小写拉丁串 → 辅音 / 元音记号序列 */
function tokenize(word: string, jAsY: boolean): Tok[] {
  let s = word.toLowerCase().replace(/[^a-z]/g, '');
  s = s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kv').replace(/q/g, 'k').replace(/x/g, 'ks');
  s = s.replace(/c(?![h])(?=[eiy])/g, 's').replace(/c(?!h)/g, 'k');
  s = s.replace(/([bdfgklprstvz])\1/g, '$1'); // 双写辅音读一个
  s = s.replace(/(nn|mm)(?![aeiouy])/g, (m) => m[0]); // nn、mm 只在元音前拆开读(Anna → 安纳,Gunnmark → 贡马克)
  const out: Tok[] = [];
  let i = 0;
  const isV = (ch: string | undefined) => !!ch && /[aeiou]/.test(ch);
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    const two = s.slice(i, i + 2);
    // y:词首或两元音之间当辅音,否则当元音 i
    if (ch === 'y') {
      if (isV(next) && (i === 0 || isV(s[i - 1]))) out.push({ c: 'y' });
      else if (isV(next) && !isV(s[i - 1])) out.push({ c: 'y' });
      else out.push({ v: 'i' });
      i++;
      continue;
    }
    if (ch === 'w') {
      if (isV(next)) out.push({ c: 'w' });
      else if (out.length && 'v' in out[out.length - 1]) (out[out.length - 1] as { v: string }).v += 'u';
      i++;
      continue;
    }
    if (VOWEL_RE.test(ch)) {
      const d = DIPH[two];
      // ai / au 后面还跟元音时不合并(Maia → 马亚)
      if (d && !isV(s[i + 2])) {
        out.push({ v: d });
        i += 2;
      } else {
        out.push({ v: ch });
        i++;
      }
      continue;
    }
    if (ch === 'j') {
      out.push({ c: jAsY ? 'y' : 'j' });
      i++;
      continue;
    }
    if (next === 'h' && 'sctkgdz'.includes(ch)) {
      out.push({ c: two === 'zh' ? 'z' : two });
      i += 2;
      continue;
    }
    if (ch === 'h') {
      // 元音后、辅音前的 h 记作 H(Bahr → 巴赫尔);词尾 h 不发音(-ah)
      const prevV = out.length > 0 && 'v' in out[out.length - 1];
      if (isV(next) || next === 'y') out.push({ c: 'h' });
      else if (prevV && next) out.push({ c: 'H' });
      i++;
      continue;
    }
    if (two === 'ts' && (isV(s[i + 2]) || i + 2 === s.length)) {
      // ts 在元音前或词尾读"茨"(Merots → 梅罗茨)
      out.push({ c: 'ts' });
      i += 2;
      continue;
    }
    if ('bcdfgklmnprstvz'.includes(ch)) {
      out.push({ c: ch });
      i++;
      continue;
    }
    throw new Error(`译音:不认识的字母 "${ch}"(${word})`);
  }
  return out;
}

interface Syl {
  onset: string; // '' 表示零声母
  vowel: string | null; // null = 单独成字的辅音
  nasal?: 'n' | 'ng';
  /** 前一个元音是 i/e(ia → 亚) */
  afterFront?: boolean;
}

/** 记号序列 → 音节 */
function syllabify(toks: Tok[]): Syl[] {
  const syl: Syl[] = [];
  let i = 0;
  let prevVowel: string | null = null;
  while (i < toks.length) {
    // 收集辅音串
    const cons: string[] = [];
    while (i < toks.length && 'c' in toks[i]) cons.push((toks[i++] as { c: string }).c);
    const v = i < toks.length ? (toks[i] as { v: string }).v : null;
    let start = 0;
    // 第一个辅音可能是前一个元音的韵尾
    if (prevVowel !== null && cons.length > 0) {
      const c0 = cons[0];
      const followingIsOnset = v !== null && cons.length === 1;
      if (!followingIsOnset) {
        if (c0 === 'n' && cons[1] === 'g' && cons.length === 2 && v === null) {
          syl[syl.length - 1].nasal = 'ng';
          start = 2;
        } else if (c0 === 'n' || (c0 === 'm' && (cons[1] === 'b' || cons[1] === 'p'))) {
          syl[syl.length - 1].nasal = 'n';
          start = 1;
        } else if (c0 === 'H' && cons.length === 1 && v === null) {
          start = 1; // 词尾 h 不发音
        }
      }
    }
    const lastIsOnset = v !== null ? 1 : 0;
    for (let k = start; k < cons.length - lastIsOnset; k++) syl.push({ onset: cons[k] === 'H' ? 'h' : cons[k], vowel: null });
    if (v === null) break;
    const onset = cons.length > start ? cons[cons.length - 1] : '';
    const afterFront = onset === '' && (prevVowel === 'i' || prevVowel === 'e');
    syl.push({ onset: onset === 'H' ? 'h' : onset, vowel: v, afterFront });
    prevVowel = v;
    i++;
  }
  return syl;
}

export function transcribe(latin: string, opts: TranscribeOptions = {}): string {
  const over = opts.table ?? {};
  const look = (key: string) => over[key] ?? BASE.get(key);
  const syl = syllabify(tokenize(latin, !!opts.jAsY));
  let out = '';
  for (let k = 0; k < syl.length; k++) {
    const s = syl[k];
    if (s.vowel === null) {
      // 单独成字的辅音;f / v 在 l、r 前写"弗"(Vladimir → 弗拉基米尔)
      const nxt = syl[k + 1];
      if ((s.onset === 'f' || s.onset === 'v') && nxt && (nxt.onset === 'l' || nxt.onset === 'r')) out += over['-' + s.onset + 'r'] ?? '弗';
      else out += over['-' + s.onset] ?? BASE_LONE[s.onset];
      continue;
    }
    const v = s.vowel;
    if (s.onset === '' && s.afterFront && v === 'a') {
      // ia / ea:亚;ian → 安(Adrian 阿德里安)
      out += s.nasal ? (over['yan'] ?? '安') : (over['ya'] ?? '亚');
      continue;
    }
    if (s.onset === '' && s.afterFront && v === 'o' && s.nasal) {
      out += over['yon'] ?? '昂'; // ion / eon:昂(Leon 莱昂、Lyon 里昂)
      continue;
    }
    if (v === 'oi') {
      out += look(s.onset + 'o') + '伊';
      continue;
    }
    if (s.nasal) {
      const key = s.onset + (s.nasal === 'ng' ? (v === 'a' ? 'ang' : v === 'o' ? 'ong' : v + 'n') : v + 'n');
      const hit = look(key);
      if (hit) {
        out += hit;
        continue;
      }
      out += (look(s.onset + v) ?? '') + '恩';
      continue;
    }
    const hit = look(s.onset + v);
    if (hit) out += hit;
    else {
      // 表里没有的组合:拆成 辅音字 + 元音字
      out += (s.onset ? BASE_LONE[s.onset] : '') + (look(v) ?? '');
    }
  }
  return out;
}
