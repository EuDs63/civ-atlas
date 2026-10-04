/**
 * 流式回复(SSE,Server-Sent Events)的解析,各服务商共用。
 *
 * 服务器一段段发回来的文本长这样(空行分隔一条消息):
 *
 *   event: delta            ← 可选:消息类型(OpenAI 兼容接口不带,我们自己的服务器带)
 *   data: {"text":"你好"}    ← 内容;一条消息可以有多行 data,按换行拼起来
 *   : keep-alive            ← 冒号开头是注释(DeepSeek 排队时发这个保活),忽略
 *
 * 网络上一块数据可能在任意位置断开(包括一个汉字的 UTF-8 字节中间),这里都能拼回去。
 */

export interface SseEvent {
  /** 没写 event: 时是 'message' */
  event: string;
  data: string;
  id?: string;
}

/** 把一段段文本喂进来,吐出完整的 SSE 消息(纯计算,单测直接用) */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;

  /** 喂一段文本,返回这段里凑齐的消息 */
  push(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    // 按行切;最后一段可能不完整,留到下次
    let start = 0;
    for (;;) {
      const nl = this.findLineEnd(start);
      if (nl < 0) break;
      const line = this.buf.slice(start, nl);
      start = nl + (this.buf[nl] === '\r' && this.buf[nl + 1] === '\n' ? 2 : 1);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** 流结束:最后一条没有以空行收尾的消息也算上 */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf);
      if (ev) out.push(ev);
      this.buf = '';
    }
    const ev = this.dispatch();
    if (ev) out.push(ev);
    return out;
  }

  private findLineEnd(from: number): number {
    for (let i = from; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c === '\n') return i;
      // 单独的 \r 也算换行;但 \r 在末尾时要等下一块,看后面是不是 \n
      if (c === '\r') return i + 1 < this.buf.length ? i : -1;
    }
    return -1;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id') this.id = value;
    return null;
  }

  private dispatch(): SseEvent | null {
    if (!this.data.length) {
      this.event = '';
      return null;
    }
    const ev: SseEvent = { event: this.event || 'message', data: this.data.join('\n') };
    if (this.id !== undefined) ev.id = this.id;
    this.data = [];
    this.event = '';
    return ev;
  }
}

/**
 * 读一个流式回复,逐条吐出消息。onChunk:每收到一块字节就调一次(用来重置"很久没回应"的计时)。
 * 读的过程中出错(断网、被取消)原样抛出,由调用方翻成中文。
 */
export async function* readSse(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder('utf-8');
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      yield* parser.push(dec.decode(value, { stream: true }));
    }
    yield* parser.push(dec.decode());
    yield* parser.end();
  } finally {
    // 提前退出(比如收到 [DONE] 就 break)时把连接关掉
    reader.cancel().catch(() => {});
  }
}

/**
 * "很久没回应就算超时"的计时器,顺带接上调用方的取消信号。
 * 每收到一块数据调 arm() 重新计时;超时或调用方取消时 signal 触发。用完调 dispose()。
 */
export function idleTimer(outer: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
  };
  arm();
  return {
    signal: ctl.signal,
    arm,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}
