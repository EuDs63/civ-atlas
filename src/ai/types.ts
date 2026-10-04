/**
 * AI 接入的公共类型(阶段 5「AI 叙事」)。各功能(写史书、释名、起名)只经过 client.ts 的 aiChat 调 AI,
 * 不直接碰服务商;用哪家、密钥、调用记录都由 AI 接入层(src/ai/)管。
 *
 * 设计原则:
 * - 两种用法:① 用我们提供的 AI,按次消耗"积分"(需要单独的服务器,尚未开放);② 使用者填自己的 AI 密钥(DeepSeek 官网、阿里云百炼)
 * - 使用者自己的 API 密钥只存在自己的浏览器里,不上传到我们的服务器;请求由网页直接发给模型厂商(两家的接口都允许网页跨域调用)
 * - 每次调用都留记录,记录只存在本地
 */

/** official = 我们提供的 AI(积分);deepseek = DeepSeek 官网 API;bailian = 阿里云百炼;mock = 测试用的假 AI(不联网,冒烟 / 单测用) */
export type AiProviderKind = 'official' | 'deepseek' | 'bailian' | 'mock';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  /** 功能名,记进调用记录:'史书' | '释名' | '起名' | '连接测试' */
  feature: string;
  /** 这次调用的简短说明,记进调用记录(如"大昌 · 第 1200—1500 年") */
  title?: string;
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 要求模型只回一个 JSON 对象(起名这类要结构化结果的功能用) */
  json?: boolean;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiResult {
  text: string;
  provider: AiProviderKind;
  model: string;
  usage?: AiUsage;
  /** 用我们提供的 AI 时,这次扣了多少积分 */
  credits?: number;
  /** 耗时(毫秒) */
  ms: number;
}

export interface AiCallOptions {
  /** 流式输出:每收到一段就回调(chunk = 这一段,full = 到目前为止的全文) */
  onDelta?: (chunk: string, full: string) => void;
  signal?: AbortSignal;
}

export type AiErrorCode =
  | 'not-configured' // 还没配置 AI(没选服务商 / 没填密钥 / 没登录)
  | 'auth' // 密钥不对 / 登录过期
  | 'quota' // 余额 / 积分不够
  | 'rate-limit' // 调用太频繁
  | 'network' // 网络不通
  | 'bad-response' // 服务商返回的东西看不懂
  | 'content-filter' // 服务商的内容安全审核拦下了请求或回复
  | 'aborted' // 用户取消
  | 'other';

/** AI 调用失败:message 是给用户看的中文 */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** 一条调用记录(只存本地)。AI 接入层写,调用记录面板读 */
export interface AiCallRecord {
  id: string;
  /** ISO 时间 */
  at: string;
  feature: string;
  title?: string;
  /** 用的哪家;'none' = 还没选任何一家(这次调用直接失败) */
  provider: AiProviderKind | 'none';
  model: string;
  ok: boolean;
  /** 失败时的错误码和中文说明 */
  error?: { code: AiErrorCode; message: string };
  usage?: AiUsage;
  credits?: number;
  ms: number;
  /** 发出去的消息和收到的全文(用户可在记录里展开看;太长的截断) */
  messages: AiMessage[];
  text?: string;
  /** 哪个世界(saveStore 的世界编号),可空 */
  world?: string;
}
