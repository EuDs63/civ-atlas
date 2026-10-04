/**
 * 小的 PNG 编码器:灰度图(8 位 / 16 位),给高度图导出用。浏览器的 canvas 只能出 8 位 RGBA,16 位灰度只能自己编。
 * 纯计算 + 平台自带的 CompressionStream('deflate')(浏览器、worker、Node 18+ 都有),不碰 DOM。
 *
 * 每行按 PNG 的五种滤波(无 / 左 / 上 / 平均 / Paeth)各试一遍,挑"字节绝对值之和最小"的那种(libpng 的默认做法),
 * 平滑的高度图压缩后通常只有原始大小的三到五成。16 位按大端序(PNG 规定)。
 */

export interface GrayImage {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  /** 8 位:Uint8Array;16 位:Uint16Array(每个像素一个值,编码时转大端序) */
  data: Uint8Array | Uint16Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;
function crcTab(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** CRC-32(PNG 每个数据块末尾的校验值) */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = crcTab();
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** tEXt 块只收 Latin-1:非 Latin-1 的字符换成问号 */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : 63;
  }
  return out;
}

/** 原始像素 → 每行"滤波类型 + 滤波后的字节"(PNG 的 IDAT 压缩前的内容) */
export function filterScanlines(img: GrayImage): Uint8Array {
  const { width: w, height: h, bitDepth } = img;
  const bpp = bitDepth === 16 ? 2 : 1;
  const stride = w * bpp;
  // 先把像素排成大端序的字节
  const raw = new Uint8Array(stride * h);
  if (bitDepth === 16) {
    const d = img.data as Uint16Array;
    for (let i = 0, j = 0; i < d.length; i++, j += 2) {
      raw[j] = d[i] >>> 8;
      raw[j + 1] = d[i] & 0xff;
    }
  } else raw.set(img.data as Uint8Array);

  const out = new Uint8Array((stride + 1) * h);
  const cand = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  const zero = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : zero;
    let bestSum = Infinity;
    let bestType = 0;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = up[i];
        let p: number;
        switch (f) {
          case 0:
            p = 0;
            break;
          case 1:
            p = a;
            break;
          case 2:
            p = b;
            break;
          case 3:
            p = (a + b) >>> 1;
            break;
          default: {
            const c = i >= bpp ? up[i - bpp] : 0;
            const pa = Math.abs(b - c);
            const pb = Math.abs(a - c);
            const pc = Math.abs(a + b - 2 * c);
            p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
        }
        const v = (cur[i] - p) & 0xff;
        cand[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = f;
        best.set(cand);
      }
    }
    const o = y * (stride + 1);
    out[o] = bestType;
    out.set(best, o + 1);
  }
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 编码成 PNG 文件的字节。text:写进 tEXt 块的说明(键 → 值,只能是 Latin-1,中文会变成问号 —— 说明写英文)。
 */
export async function encodeGrayPng(img: GrayImage, text: Record<string, string> = {}): Promise<Uint8Array> {
  const { width: w, height: h, bitDepth } = img;
  if (!(w > 0 && h > 0) || img.data.length !== w * h) throw new Error(`PNG 尺寸不对:${w}×${h},像素 ${img.data.length}`);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = bitDepth;
  ihdr[9] = 0; // 灰度
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = await deflate(filterScanlines(img));
  const parts: Uint8Array[] = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(text)) {
    const key = latin1(k.slice(0, 79));
    const val = latin1(v);
    const body = new Uint8Array(key.length + 1 + val.length);
    body.set(key, 0);
    body.set(val, key.length + 1);
    parts.push(chunk('tEXt', body));
  }
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
