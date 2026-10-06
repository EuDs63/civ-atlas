/**
 * 东方旗上的神兽:四灵和《山海经》里的几种,画成一色的平面剪影(学剪纸、汉画像石,不画细节)。
 * 100 × 100 的格子,身体都用"脊线 + 粗细"生成(像毛笔一笔拉出来),再加头、角、爪。
 * col = 神兽的颜色(外层 <g> 的 fill),u = 底色(眼睛、斑纹这些"抠出来"的地方)
 */
import type { Beast } from '../../gen/civ/flags';

type P = [number, number];

/** 三次贝塞尔取点 */
function bez(p0: P, p1: P, p2: P, p3: P, n = 24): P[] {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}
/** 几段贝塞尔连成一条脊线:segs = [[c1, c2, end], …] */
function spine(start: P, segs: [P, P, P][], n = 24): P[] {
  const pts: P[] = [start];
  let cur = start;
  for (const [c1, c2, e] of segs) {
    pts.push(...bez(cur, c1, c2, e, n).slice(1));
    cur = e;
  }
  return pts;
}
function normals(pts: P[]): P[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l] as P;
  });
}
const f = (v: number) => v.toFixed(1);
const poly = (ps: P[]) => `M${ps.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`;

/** 沿脊线按粗细 w(t) 生成一条笔画的轮廓 */
function stroke(pts: P[], w: (t: number) => number): string {
  const ns = normals(pts);
  const L: P[] = [], R: P[] = [];
  pts.forEach((p, i) => {
    const h = w(i / (pts.length - 1)) / 2;
    L.push([p[0] + ns[i][0] * h, p[1] + ns[i][1] * h]);
    R.push([p[0] - ns[i][0] * h, p[1] - ns[i][1] * h]);
  });
  return poly([...L, ...R.reverse()]);
}
/** 沿脊线一侧长刺(龙背上的鳍):side = 1 左、-1 右 */
function spikes(pts: P[], w: (t: number) => number, from: number, to: number, count: number, len: number, side = 1): string {
  const ns = normals(pts);
  let d = '';
  for (let k = 0; k < count; k++) {
    const t = from + ((to - from) * (k + 0.5)) / count;
    const i = Math.round(t * (pts.length - 1));
    const j0 = Math.max(0, i - 2), j1 = Math.min(pts.length - 1, i + 2);
    const base = (j: number): P => { const h = (w(j / (pts.length - 1)) / 2) * side; return [pts[j][0] + ns[j][0] * h, pts[j][1] + ns[j][1] * h]; };
    const a = base(j0), b = base(j1);
    const h = (w(t) / 2) * side;
    const tip: P = [pts[i][0] + ns[i][0] * (h + len * side) - (pts[j1][0] - pts[j0][0]) * 0.35, pts[i][1] + ns[i][1] * (h + len * side) - (pts[j1][1] - pts[j0][1]) * 0.35];
    d += poly([a, tip, b]);
  }
  return d;
}
/** 一串轮廓拆成各自独立的 <path>,叠在一起也不会互相抠出洞 */
const solid = (d: string) => d.split(/(?=M)/).filter(Boolean).map((x) => `<path stroke="none" d="${x}"/>`).join('');
/** 带锯齿的笔画:一侧(side)在 [from, to] 之间长出 teeth 个齿,齿高 len */
function strokeSaw(pts: P[], w: (t: number) => number, from: number, to: number, teeth: number, len: number, side = 1): string {
  const ns = normals(pts);
  const n = pts.length - 1;
  const L: P[] = [], R: P[] = [];
  pts.forEach((p, i) => {
    const t = i / n;
    const h = w(t) / 2;
    let extra = 0;
    if (t >= from && t <= to) {
      const u = ((t - from) / (to - from)) * teeth;
      const fr = u - Math.floor(u);
      extra = len * (fr < 0.7 ? fr / 0.7 : (1 - fr) / 0.3) * Math.sin(Math.PI * ((t - from) / (to - from)) * 0.9 + 0.15);
    }
    const hl = side === 1 ? h + extra : h, hr = side === -1 ? h + extra : h;
    L.push([p[0] + ns[i][0] * hl, p[1] + ns[i][1] * hl]);
    R.push([p[0] - ns[i][0] * hr, p[1] - ns[i][1] * hr]);
  });
  return poly([...L, ...R.reverse()]);
}
const lerp = (a: number, b: number) => (t: number) => a + (b - a) * t;
const taperTo = (a: number, b: number, k = 1) => (t: number) => a + (b - a) * t ** k;

const BEAST: Record<Beast, (u: string) => string> = {
  // 龙:身子一起一伏,背上一排鳍,四只小爪,张口追着下方一颗火珠(清代黄龙旗的"龙戏珠")
  long: (u) => {
      const sp: P[] = [];
      for (let i = 0; i <= 120; i++) {
        const t = i / 120;
        sp.push([32 + 60 * t, 44 - 16 * Math.cos(2.5 * Math.PI * t) * (1 - 0.25 * t)]);
      }
      const w = (t: number) => (t < 0.12 ? 9 + (t / 0.12) * 3 : 12 * (1 - (t - 0.12) / 0.88) ** 0.85 + 1.4);
      let d = stroke(sp, w) + spikes(sp, w, 0.08, 0.9, 11, 5.5, -1);
      const ns = normals(sp);
      // 头:朝左,张口;上颚长、鼻头上翘,下颚短
      d += 'M35 24L28 19L22 19L13 21L6 18L4 23L8 26L17 27L23 29L10 31L8 35L22 37L28 39L35 38Z';
      // 鹿角:两支往后上,各带一个小叉
      d += stroke(spine([27, 20], [[[29, 13], [34, 8], [42, 6]]], 14), taperTo(4, 1));
      d += stroke(spine([31, 11], [[[33, 9], [34, 6], [33, 3]]], 8), taperTo(2.4, 0.6));
      d += stroke(spine([22, 20], [[[22, 13], [25, 8], [30, 5]]], 14), taperTo(3.4, 0.8));
      // 须:从鼻头往下飘
      d += stroke(spine([7, 25], [[[2, 30], [3, 38], [9, 42]]], 14), taperTo(2.2, 0.6));
      // 鬃:三缕往后飘
      for (const [y, e] of [[22, 16], [28, 24], [34, 34]] as [number, number][]) d += stroke(spine([33, y], [[[38, y - 1], [42, e], [48, e - 2]]], 10), taperTo(4.2, 0.6));
      // 四只小爪,长在身子下沿,每只三根趾
      const leg = (t: number, a1: number, a2: number) => {
        const i = Math.round(t * 120);
        const h = w(t) / 2 - 1;
        const x = sp[i][0] - ns[i][0] * h, y = sp[i][1] - ns[i][1] * h;
        const knee: P = [x + Math.cos(a1) * 7, y + Math.sin(a1) * 7];
        const foot: P = [knee[0] + Math.cos(a2) * 5, knee[1] + Math.sin(a2) * 5];
        let out = stroke([[x, y], knee, foot], taperTo(5, 2.8));
        for (const o of [-0.7, 0, 0.7]) out += stroke([foot, [foot[0] + Math.cos(a2 + o) * 4.5, foot[1] + Math.sin(a2 + o) * 4.5]], taperTo(2.4, 0.4));
        return out;
      };
      d += leg(0.22, 2.1, 2.7) + leg(0.32, 1.3, 0.6) + leg(0.66, 2.1, 2.7) + leg(0.76, 1.3, 0.6);
      // 尾梢一簇火
      const e = sp[120];
      d += stroke(spine(e, [[[e[0] + 2, e[1] - 6], [e[0] - 2, e[1] - 12], [e[0] + 3, e[1] - 16]]], 10), taperTo(3.6, 0.6));
      d += stroke(spine(e, [[[e[0] + 4, e[1] - 3], [e[0] + 6, e[1] - 8], [e[0] + 8, e[1] - 10]]], 10), taperTo(3, 0.6));
      // 火珠:口前下方一颗,上面三缕火
      d += 'M18 50C24 50 27 55 27 60C27 66 22 69 17 69C12 69 8 65 8 60C8 55 12 50 18 50Z';
      for (const [x, a] of [[11, -2.2], [17, -1.6], [23, -1.0]] as [number, number][]) d += stroke(spine([x, 53], [[[x + Math.cos(a) * 4, 53 + Math.sin(a) * 4], [x + Math.cos(a) * 6 + 2, 53 + Math.sin(a) * 7], [x + Math.cos(a) * 8 + 4, 53 + Math.sin(a) * 9]]], 10), taperTo(3.4, 0.6));
      // 整条往下挪,让龙和珠一起居中
      return `<g transform="translate(0 12)">${solid(d)}<circle stroke="none" fill="${u}" cx="24" cy="24" r="2"/><path fill="none" stroke="${u}" stroke-width="2" stroke-linecap="round" d="M13 58Q17 54 21 58Q23 63 18 64"/></g>`;
  },
  // 凤:《山海经·南山经》"其状如鸡,五采而文,名曰凤皇";冠、扬起的翅、三根长尾翎
  feng: (u) => {
      let d = '';
      // 身子 + 脖子
      d += stroke(spine([24, 26], [[[28, 36], [26, 48], [44, 58]]], 20), (t) => 7 + t * 12);
      d += stroke(spine([38, 56], [[[46, 64], [56, 64], [62, 60]]], 12), taperTo(16, 8));
      // 头、喙
      d += `M18 24C18 18 26 16 29 21C31 25 28 29 24 30C21 30 18 28 18 24Z`;
      d += `M19 22L9 26L19 27Z`;
      // 冠:三根小翎
      for (const [x, y, a] of [[23, 18, -2.3], [26, 18, -1.9], [28, 20, -1.5]] as [number, number, number][]) d += stroke(spine([x, y], [[[x + Math.cos(a) * 3, y + Math.sin(a) * 4], [x + Math.cos(a) * 6 + 2, y + Math.sin(a) * 8], [x + Math.cos(a) * 9 + 4, y + Math.sin(a) * 10]]], 10), taperTo(2.4, 0.6));
      // 翅:五根羽,从肩上往右上扬
      for (let k = 0; k < 5; k++) {
        const a = -1.25 + k * 0.2;
        const l = 40 - k * 4;
        const s: P = [40, 50];
        const e: P = [s[0] + Math.cos(a) * l, s[1] + Math.sin(a) * l];
        d += stroke(spine(s, [[[s[0] + Math.cos(a - 0.3) * l * 0.4, s[1] + Math.sin(a - 0.3) * l * 0.4], [e[0] - 4, e[1] + 2], e]], 16), (t) => 7 * Math.sin(Math.PI * (0.15 + t * 0.85)) + 0.6);
      }
      // 尾翎:三根长的,末端打卷
      const tails: [P, P, P, P][] = [
        [[58, 60], [76, 58], [94, 66], [90, 80]],
        [[56, 64], [70, 72], [84, 86], [74, 94]],
        [[52, 66], [58, 80], [62, 92], [52, 96]],
      ];
      for (const [a, b, c, e] of tails) d += stroke(bez(a, b, c, e, 24), (t) => 5.5 * (1 - t) + 1.5 + (t > 0.85 ? 3 : 0));
      let out = solid(d);
      out += `<circle stroke="none" fill="${u}" cx="24" cy="23" r="1.6"/>`;
      // 尾梢的"眼"
      for (const [x, y] of [[90, 80], [74, 94], [52, 96]]) out += `<circle stroke="none" cx="${x}" cy="${y}" r="4.6"/><circle stroke="none" fill="${u}" cx="${x}" cy="${y}" r="1.8"/>`;
      return out;
  },
  // 九尾狐:《山海经·南山经》青丘之山"有兽焉,其状如狐而九尾";九条尾从臀部一起甩出,往上往后散开
  hu: (u) => {
      let d = '';
      const root: P = [70, 52];
      for (let k = 0; k < 9; k++) {
        const th = -2.15 + k * 0.23;
        const l = 36 - k * 1.6;
        const e: P = [root[0] + 4 + Math.cos(th) * l, root[1] + Math.sin(th) * l];
        const c1: P = [root[0] + 8, root[1] - 3];
        const c2: P = [e[0] - Math.cos(th - 0.6) * l * 0.4, e[1] - Math.sin(th - 0.6) * l * 0.4];
        // 每条都是蓬松的狐尾:中段最粗,梢尖
        d += stroke(bez(root, c1, c2, e, 24), (t) => 1 + 8.5 * Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)) ** 0.7);
      }
      // 身子:往左走
      d += stroke(spine([30, 56], [[[42, 50], [58, 51], [74, 54]]], 20), (t) => 13 - t * 2);
      // 脖子 + 头:尖嘴、两只尖耳
      d += 'M38 54L34 44L32 36L28 42L25 34L22 44L10 52L8 55L16 57L26 60L36 62Z';
      // 前腿一前一后;后腿先往前到膝,再往后到踝
      d += stroke([[32, 60], [27, 70], [23, 80]], taperTo(6, 3.2)) + stroke([[23, 80], [18, 81]], () => 3.2);
      d += stroke([[38, 60], [38, 71], [37, 81]], taperTo(6, 3.2)) + stroke([[37, 81], [32, 82]], () => 3.2);
      d += stroke([[66, 56], [61, 66], [68, 74], [65, 82]], taperTo(9, 3.2)) + stroke([[65, 82], [60, 83]], () => 3.2);
      d += stroke([[73, 55], [71, 65], [78, 72], [77, 81]], taperTo(8, 3.2)) + stroke([[77, 81], [72, 82]], () => 3.2);
      return solid(d) + `<circle stroke="none" fill="${u}" cx="23" cy="47" r="1.8"/>`;
  },
  // 白虎:《礼记·曲礼》行军"前朱鸟而后玄武,左青龙而右白虎",四面各打一种神兽旗;画成迈步的老虎,身上带斑纹
  baihu: (u) => {
      let d = '';
      // 身子:胸深、腰细、臀圆,往左走
      const sp = spine([28, 50], [[[42, 43], [62, 44], [78, 50]]], 30);
      const bw = (t: number) => 21 - 7 * Math.sin(Math.PI * t) - 2 * t;
      d += stroke(sp, bw);
      // 头:圆脸、短吻,两只圆耳
      d += 'M32 40C28 33 16 33 12 38C9 41 6 44 5 48L7 52L13 55C20 59 29 57 33 51Z';
      d += 'M12 41C9 34 15 31 18 37Z M21 37C21 30 28 30 29 36Z';
      // 四条腿:前腿直,后腿带弯;脚掌圆
      const paw = (x: number, y: number) => `M${f(x - 5)} ${f(y)}C${f(x - 5)} ${f(y - 4)} ${f(x + 4)} ${f(y - 4)} ${f(x + 4)} ${f(y)}L${f(x + 4)} ${f(y + 2)}H${f(x - 6)}Z`;
      d += stroke([[26, 54], [24, 66], [23, 78]], taperTo(10, 6.5)) + paw(22, 79);
      d += stroke([[36, 54], [38, 66], [40, 78]], taperTo(9, 6.5)) + paw(39, 79);
      d += stroke([[72, 50], [77, 62], [72, 70], [73, 78]], taperTo(13, 6.5)) + paw(72, 79);
      d += stroke([[64, 52], [67, 62], [61, 70], [61, 78]], taperTo(11, 6.5)) + paw(60, 79);
      // 尾:从臀部扬起,梢往前卷
      d += stroke(spine([78, 47], [[[88, 46], [95, 38], [93, 28]], [[91, 20], [95, 14], [99, 17]]], 20), taperTo(5.5, 3));
      let out = solid(d);
      // 斑纹:从背上往下几道弯楔,尾上两道,额上一道
      const ns = normals(sp);
      let st = '';
      for (const t of [0.3, 0.42, 0.54, 0.66, 0.78]) {
        const i = Math.round(t * (sp.length - 1));
        const h = bw(t) / 2;
        const top: P = [sp[i][0] - ns[i][0] * h, sp[i][1] - ns[i][1] * h];
        const len = h * 1.15;
        st += stroke(bez(top, [top[0] - 2, top[1] + len * 0.3], [top[0] - 3, top[1] + len * 0.7], [top[0] - 1, top[1] + len], 10), taperTo(3.6, 0.3));
      }
      st += stroke([[95, 33], [98, 31]], taperTo(2.4, 0.4)) + stroke([[91, 23], [94, 20]], taperTo(2.2, 0.4));
      st += stroke([[24, 37], [27, 42]], taperTo(2.4, 0.4));
      out += `<g fill="${u}">${solid(st)}</g>`;
      out += `<circle stroke="none" fill="${u}" cx="16" cy="44" r="2"/>`;
      return out;
  },
  // 旋龟:《山海经·南山经》"其状如龟而鸟首虺尾"(四灵的玄武也是龟蛇)
  gui: (u) => {
      let d = '';
      // 甲:半椭圆
      d += `M22 62C22 36 36 26 52 26C68 26 82 36 82 62Z`;
      // 鸟首:弯脖子 + 尖喙
      d += stroke(spine([26, 56], [[[18, 52], [14, 44], [16, 36]]], 16), taperTo(9, 7));
      d += `M12 34C12 28 20 28 22 32C22 36 18 38 15 38Z M13 32L3 36L13 37Z`;
      // 蛇尾:卷起
      d += stroke(spine([80, 58], [[[94, 58], [98, 44], [90, 38]], [[84, 34], [80, 42], [86, 44]]], 16), taperTo(7, 1.2, 0.9));
      // 四只脚
      for (const [x, dx] of [[30, -7], [42, -3], [62, 3], [74, 7]] as [number, number][]) d += stroke([[x, 58], [x + dx, 66], [x + dx * 1.5, 71]], (t) => 10 - t * 3);
      let out = solid(d);
      // 甲上的纹:中间一块六角、两边各一块,下沿一道边
      const hex = (cx: number, cy: number, r: number) => poly([0, 1, 2, 3, 4, 5].map((k) => [cx + Math.cos((k * Math.PI) / 3) * r, cy + Math.sin((k * Math.PI) / 3) * r * 0.85] as P));
      out += `<path stroke="none" fill="${u}" d="${hex(52, 42, 8)}${hex(35, 50, 6.5)}${hex(69, 50, 6.5)}"/>`;
      out += `<circle stroke="none" fill="${u}" cx="17" cy="32" r="1.5"/>`;
      return out;
  },
  // 文鳐鱼:《山海经·西山经》"状如鲤鱼,鱼身而鸟翼"
  yao: (u) => {
      let d = '';
      // 鱼身:朝左上游
      d += stroke(spine([12, 58], [[[30, 46], [56, 50], [76, 62]]], 24), (t) => 4 + 20 * Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.95)) ** 0.9);
      // 尾:分叉
      d += `M72 60L94 46L86 64L96 80Z`;
      // 鸟翼:四根羽,从背上往右上扬
      for (let k = 0; k < 4; k++) {
        const a = -1.45 + k * 0.24;
        const s: P = [40, 46];
        const l = 36 - k * 4;
        const e: P = [s[0] + Math.cos(a) * l + 10, s[1] + Math.sin(a) * l];
        d += stroke(spine(s, [[[s[0] + 2, s[1] - 10], [e[0] - 6, e[1] + 4], e]], 16), (t) => 7 * Math.sin(Math.PI * (0.15 + t * 0.85)) + 0.6);
      }
      // 腹鳍
      d += `M40 66L36 78L48 68Z`;
      let out = solid(d);
      out += `<circle stroke="none" fill="${u}" cx="20" cy="54" r="2"/>`;
      // 鳃:一道弧
      out += `<path fill="none" stroke="${u}" stroke-width="2.6" stroke-linecap="round" d="M30 48Q35 56 30 64"/>`;
      return out;
  },
  // 毕方:《山海经·西山经》"其状如鹤,一足……名曰毕方";见则其邑有讹火
  bifang: (u) => {
      let d = '';
      // 身子
      d += `M36 50C44 40 62 40 70 48C76 54 74 62 64 64C52 66 40 62 36 50Z`;
      // 长脖子(S 形)+ 头 + 长喙
      d += stroke(spine([40, 50], [[[30, 42], [36, 30], [30, 22]]], 20), taperTo(8, 4.5));
      d += `M26 22C26 16 34 16 34 21C34 25 30 26 28 26Z M27 20L8 24L27 24Z`;
      // 冠
      d += `M30 16C32 10 36 10 38 14C35 14 33 15 31 18Z`;
      // 一只脚
      d += stroke([[56, 63], [55, 76], [54, 90]], taperTo(3.6, 2.4));
      d += stroke([[54, 90], [46, 92]], taperTo(2.4, 1)) + stroke([[54, 90], [62, 93]], taperTo(2.4, 1));
      // 翅:收起的,翅尖朝后上
      d += stroke(spine([48, 48], [[[62, 40], [80, 34], [92, 24]]], 20), (t) => 12 * (1 - t) + 1);
      d += stroke(spine([52, 54], [[[66, 52], [82, 46], [94, 40]]], 20), (t) => 9 * (1 - t) + 1);
      // 尾羽
      d += `M70 56L88 62L72 62Z`;
      let out = solid(d);
      out += `<circle stroke="none" fill="${u}" cx="30" cy="20" r="1.5"/>`;
      return out;
  },
  // 兽面(饕餮):商周青铜器的正面兽面;左右对称,一对卷角、一对眼、鼻梁、獠牙
  taotie: (u) => {
      // 画左半边,再镜像
      let half = '';
      // 卷角:从额头往外上扬再往下卷
      half += stroke(spine([46, 30], [[[38, 14], [18, 8], [10, 18]], [[4, 26], [10, 36], [18, 32]]], 24), taperTo(10, 3, 0.8));
      // 脸:上宽下窄
      half += 'M50 28H30C20 28 16 36 18 46C20 56 28 62 36 64L40 72H50Z';
      // 耳
      half += 'M19 38L6 32L8 46L18 48Z';
      // 獠牙
      half += 'M38 64L40 80L45 68Z';
      const eye = `<path stroke="none" fill="${u}" d="M24 44Q32 34 42 42Q34 52 24 44Z"/><circle stroke="none" cx="34" cy="43" r="3.4"/>`;
      const nose = `<path stroke="none" fill="${u}" d="M47 32H53V52Q58 54 58 58Q54 62 50 58Q46 62 42 58Q42 54 47 52Z"/>`;
      const L = solid(half);
      return L + `<g transform="translate(100 0) scale(-1 1)">${L}</g>` + eye + `<g transform="translate(100 0) scale(-1 1)">${eye}</g>` + nose;
  },
};

/** 一只神兽:中心 (cx, cy)、占 size × size 的格子 */
export function beastSvg(b: Beast, col: string, under: string, cx: number, cy: number, size: number): string {
  const k = size / 100;
  return `<g transform="translate(${cx - 50 * k} ${cy - 50 * k}) scale(${k})" fill="${col}" stroke="${col}">${BEAST[b](under)}</g>`;
}
