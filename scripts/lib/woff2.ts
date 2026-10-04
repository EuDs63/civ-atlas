/**
 * 读 WOFF2 字体里有哪些字(cmap 表),不依赖第三方库:Node 自带 Brotli 解压 + 按规范解析表目录。
 * 规范:https://www.w3.org/TR/WOFF2/ 。cmap 表在 WOFF2 里从不做变换,解压后原样可读。
 */
import zlib from 'node:zlib';

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** WOFF2 → 各表(解压后的原始字节;glyf / loca / hmtx 可能是变换过的,这里用不到) */
export function woff2Tables(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0) !== 0x774f4632) throw new Error('不是 WOFF2 文件');
  const numTables = dv.getUint16(12);
  const totalCompressed = dv.getUint32(20);
  let p = 48;
  const readBase128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('UIntBase128 太长');
  };
  const dir: { tag: string; len: number }[] = [];
  for (let t = 0; t < numTables; t++) {
    const flags = buf[p++];
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 63) {
      tag = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      p += 4;
    } else tag = KNOWN_TAGS[idx];
    const version = flags >> 6;
    const orig = readBase128();
    // glyf / loca:version 0 = 变换过;其余表:version 非 0 = 变换过。变换过的表后面跟着变换后长度
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const len = transformed ? readBase128() : orig;
    dir.push({ tag, len });
  }
  const flavor = dv.getUint32(4);
  if (flavor === 0x74746366) throw new Error('不支持字体集合(ttcf)');
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + totalCompressed));
  const out = new Map<string, Uint8Array>();
  let off = 0;
  for (const d of dir) {
    out.set(d.tag, data.subarray(off, off + d.len));
    off += d.len;
  }
  return out;
}

/** 解析 cmap 表(格式 4 和 12),返回映射到非空字形的所有码位 */
export function cmapCodepoints(cmap: Uint8Array): Set<number> {
  const dv = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const n = dv.getUint16(2);
  const out = new Set<number>();
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(4 + i * 8 + 4);
    if (seen.has(off)) continue;
    seen.add(off);
    const format = dv.getUint16(off);
    if (format === 4) {
      const segX2 = dv.getUint16(off + 6);
      const seg = segX2 / 2;
      const ends = off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < seg; s++) {
        const end = dv.getUint16(ends + s * 2);
        const start = dv.getUint16(starts + s * 2);
        const delta = dv.getInt16(deltas + s * 2);
        const ro = dv.getUint16(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const gi = ranges + s * 2 + ro + (c - start) * 2;
            g = dv.getUint16(gi);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = dv.getUint32(off + 12);
      for (let gIdx = 0; gIdx < groups; gIdx++) {
        const b = off + 16 + gIdx * 12;
        const start = dv.getUint32(b);
        const end = dv.getUint32(b + 4);
        const g0 = dv.getUint32(b + 8);
        for (let c = start; c <= end; c++) if (g0 + (c - start) !== 0) out.add(c);
      }
    }
  }
  return out;
}

/** WOFF2 字体里有字形的所有字符 */
export function woff2Chars(buf: Uint8Array): Set<string> {
  const cmap = woff2Tables(buf).get('cmap');
  if (!cmap) throw new Error('字体里没有 cmap 表');
  return new Set([...cmapCodepoints(cmap)].map((c) => String.fromCodePoint(c)));
}

/** name 表里的某一项(英文优先),用来核对字体名和版权 */
export function woff2Name(buf: Uint8Array, nameId: number): string | undefined {
  const name = woff2Tables(buf).get('name');
  if (!name) return undefined;
  const dv = new DataView(name.buffer, name.byteOffset, name.byteLength);
  const count = dv.getUint16(2);
  const strOff = dv.getUint16(4);
  let best: string | undefined;
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = dv.getUint16(r);
    const lang = dv.getUint16(r + 4);
    const id = dv.getUint16(r + 6);
    const len = dv.getUint16(r + 8);
    const off = dv.getUint16(r + 10);
    if (id !== nameId || platform !== 3) continue;
    let s = '';
    for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(strOff + off + k));
    if (lang === 0x409) return s;
    best ??= s;
  }
  return best;
}
