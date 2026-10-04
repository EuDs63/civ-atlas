/** subset-font(npm)没有自带类型声明,这里只声明 scripts/subset-fonts.ts 用到的部分 */
declare module 'subset-font' {
  interface SubsetFontOptions {
    targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype';
    preserveNameIds?: number[];
    keepFeatures?: string[];
    variationAxes?: Record<string, number | { min: number; max: number; default?: number }>;
    noLayoutClosure?: boolean;
    glyphNames?: boolean;
    noHinting?: boolean;
    dropTables?: string[];
  }
  export default function subsetFont(font: Buffer | Uint8Array, text: string, options?: SubsetFontOptions): Promise<Buffer>;
}
