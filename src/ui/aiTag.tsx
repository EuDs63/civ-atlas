/**
 * "AI 写"小标签:标在 AI 起的名字、AI 写的名字由来、史书旁边(作者把地图、编年史发出去时好照规定声明)。
 * 地图上的地名不标;「使用 AI 功能」关着时 AI 起的名字照样标(名字还在用)。
 */
import type { CSSProperties } from 'react';
import './ai.css';

export function AiTag({ style }: { style?: CSSProperties }) {
  return (
    <span className="ai-tag" title="这是 AI 写的" style={style}>
      AI 写
    </span>
  );
}
