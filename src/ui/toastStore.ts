/**
 * 顶部居中的提示条(界面骨架):同一时间只显示一条。
 *
 *   showToast({ kind, text, progress?, more?, action?, actions?, ttl?, id? })  显示 / 更新一条,返回它的 id
 *   clearToast(id?)                                               收起这一条(不给 id = 收起正在显示的那条)
 *   useToast() / getToast()                                        正在显示的那条(没有 = null)
 *   useToastOpen(id, act?)                                         某个来源的那条还在不在(可以只认右边是 act 这个按钮的)
 *
 * 几个来源各自一条(生成进度、重推历史、选目标、存档通知、导出……),按 id 区分:
 * 同一个 id 再 show 就是更新(并排到最前);显示的是最近 show 的那条,它收起以后露出下面还在的那条
 * (比如选目标时来了一条存档通知,通知收起后选目标的提示还在)。例外:ok 类的不盖住还开着的警告 / 出错
 * (带按钮的除外:"撤销"这类过几秒就收,排在下面就一眼都看不到)。
 * 纯状态,不碰 DOM(saveStore 在 Node 单测里也会用到)。
 *
 * 文案约定(各种状态统一走这里,不另开窗口):一行主文字 + 至多一行小字(more 有几条也并成一行);
 * 进行中写"正在…"(不加省略号,进度条 / 转圈已经说明在进行),做完写"已…",失败写"…失败""打不开…""没写完";
 * 按钮用动词短语("撤销""重试""去设置""用链接里的""保留本地")。
 */
import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'progress' | 'ok' | 'warn' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** 主按钮(主色底):两个按钮二选一时标出推荐的那个 */
  primary?: boolean;
  /** 按钮的 data-act(冒烟检查按它点) */
  act?: string;
}

export interface ToastInput {
  kind: ToastKind;
  /** 第一行 */
  text: string;
  /** kind = 'progress' 时的进度 0–1(不给 = 转圈,不知道还要多久) */
  progress?: number;
  /** 第二行小字(给几条就用" · "连成一行) */
  more?: string[];
  /** 右侧的按钮:"撤销""取消""下载说明" */
  action?: ToastAction;
  /** 右侧有两个按钮时(二选一:"用链接里的""保留本地"),按顺序排;给了它就不看 action */
  actions?: ToastAction[];
  /** 多久后自动收起(毫秒);不给:ok = 7 秒,其余一直留着。0 = 一直留着 */
  ttl?: number;
  /** 右边带关闭按钮(不给:warn / error 带,其余不带) */
  dismissible?: boolean;
  /** 左边一个绿点(ok 类里要强调"办成了"的:世界创建好了) */
  dot?: boolean;
  /** 来源;同一来源的提示互相替换。不给 = 'default' */
  id?: string;
}

export interface Toast extends ToastInput {
  id: string;
  /** 每次 show 都不同(组件据此重放出场动画、重算计时) */
  stamp: number;
}

/** ok 类提示默认停留多久 */
export const OK_TTL = 7000;

let list: Toast[] = [];
let seq = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function stopTimer(id: string) {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
}

export function showToast(t: ToastInput): string {
  const id = t.id ?? 'default';
  const toast: Toast = { ...t, id, stamp: ++seq };
  const rest = list.filter((x) => x.id !== id);
  // "已完成"类的提示不盖住还没看的警告 / 出错(排在它们下面,警告关掉后再露出来);
  // 带按钮的("撤销")照常排最前:它到时就收,等警告关掉再露出来就晚了
  const yields = t.kind === 'ok' && !t.action && !t.actions?.length;
  const firstWarn = yields ? rest.findIndex((x) => x.kind === 'warn' || x.kind === 'error') : -1;
  list = firstWarn >= 0 ? [...rest.slice(0, firstWarn), toast, ...rest.slice(firstWarn)] : [...rest, toast];
  stopTimer(id);
  const ttl = t.ttl ?? (t.kind === 'ok' ? OK_TTL : undefined);
  if (ttl !== undefined && ttl > 0 && Number.isFinite(ttl)) {
    const stamp = toast.stamp;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        if (list.some((x) => x.id === id && x.stamp === stamp)) {
          list = list.filter((x) => x.id !== id);
          emit();
        }
      }, ttl),
    );
  }
  emit();
  return id;
}

/** 收起 id 这一条(不给 = 收起正在显示的那条);没有这一条就什么都不做 */
export function clearToast(id?: string) {
  const target = id ?? list[list.length - 1]?.id;
  if (target === undefined || !list.some((x) => x.id === target)) return;
  stopTimer(target);
  list = list.filter((x) => x.id !== target);
  emit();
}

/** 正在显示的那条 */
export function getToast(): Toast | null {
  return list[list.length - 1] ?? null;
}

/** 某个来源的那条(不管是不是正在显示) */
export function peekToast(id: string): Toast | null {
  return list.find((x) => x.id === id) ?? null;
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    getToast,
    getToast,
  );
}

/** 某个来源的那条还在不在(不管是不是正在显示;给了 act 就只认右边是这个按钮的)。只在有 / 没有变了时重画 */
export function useToastOpen(id: string, act?: string): boolean {
  const has = () => list.some((x) => x.id === id && (act === undefined || x.action?.act === act));
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), has, has);
}

/** 单测用 */
export function _resetToasts() {
  for (const id of [...timers.keys()]) stopTimer(id);
  list = [];
  emit();
}
