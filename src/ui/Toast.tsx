/**
 * 顶部居中的提示条(同一时间只有一条;状态在 toastStore.ts)。
 *
 *   info     选目标之类的操作提示(左边一个主色小菱形),常带"取消"
 *   progress 生成世界 / 重推历史 / 导出:给了 progress 画进度条,没给画转圈
 *   ok       已生效、已存档……默认 7 秒后收起;带"撤销"之类的链接按钮;dot = 左边一个绿点(世界创建好了)
 *   warn / error  留着,右边有关闭按钮;可以带一个或两个按钮(分享链接和本地存档冲突:"用链接里的""保留本地")
 * 一行主文字 + 至多一行小字(more 有几条也连成一行)。
 */
import { clearToast, useToast, type ToastAction } from './toastStore';
// 各种状态里提示条之外的样式(首次打开时四角先藏着、史书进度条的"还没回字")
import './states.css';

export { clearToast, getToast, peekToast, showToast, useToast, type Toast, type ToastInput, type ToastKind } from './toastStore';

export function ToastBar() {
  const t = useToast();
  if (!t) return null;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const mark = t.kind === 'info' || t.kind === 'progress';
  const dismiss = t.dismissible ?? (t.kind === 'warn' || t.kind === 'error');
  const more = t.more?.filter(Boolean).join(' · ');
  const acts: ToastAction[] = t.actions ?? (t.action ? [t.action] : []);
  // ok 类只有一个按钮时是链接样式("撤销");两个按钮时第一个(或标了 primary 的)是主按钮
  const link = t.kind === 'ok' && acts.length === 1;
  return (
    <div
      key={t.id}
      className={`toast k-${t.kind}`}
      role={t.kind === 'error' ? 'alert' : 'status'}
      data-toast={t.id}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
    >
      {mark ? <i className="toast-mark" aria-hidden="true" /> : t.dot && <i className="toast-mark ok" aria-hidden="true" />}
      <span className="toast-text">
        <span className="toast-main">{t.text}</span>
        {more && <span className="toast-more">{more}</span>}
      </span>
      {t.kind === 'progress' &&
        (t.progress !== undefined ? (
          <span className="toast-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(Math.min(1, Math.max(0, t.progress)) * 100)}%` }} />
          </span>
        ) : (
          <i className="toast-spin" aria-hidden="true" />
        ))}
      {acts.length > 0 && (
        <span className="toast-acts">
          {acts.map((a, i) => (
            <button
              key={i}
              className={`toast-act${link ? ' link' : ''}${a.primary ? ' primary' : ''}`}
              data-act={a.act}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </span>
      )}
      {dismiss && (
        <button className="toast-x" onClick={() => clearToast(t.id)} title="关闭" aria-label="关闭">
          ✕
        </button>
      )}
    </div>
  );
}
