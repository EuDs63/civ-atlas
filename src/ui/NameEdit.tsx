/**
 * 面板里可以改的名字(国家、城、地理实体、州、民族):点名字(或面板底部的"改名")变输入框,回车 / 点别处确定,Esc 取消;
 * 输入时下面一行预览(国家:国号变迁"昌部 → 昌国 → 大昌 → 大昌王朝");改过的名字旁边有"恢复默认"。
 * 改名记在 editsStore(稳定键 → 新名字),App 套到 civ 上,地图、面板、编年史立刻跟着变。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cleanName, type KeyKind } from '../gen/edits';
import { setName } from './editsStore';

export interface NameEditProps {
  /** 稳定键 */
  k: string;
  kind: KeyKind;
  eastern?: boolean;
  /** 平时显示的(国家:当年全称) */
  shown: string;
  /** 输入框里的初值(国家:国名词根) */
  current: string;
  /** 默认名(没改过时的) */
  fallback: string;
  names: Record<string, string>;
  /** 输入时的预览(国家:国号变迁) */
  preview?: (name: string) => string;
  hint?: string;
  /** 面板标题的大字 */
  big?: boolean;
  /** 由外面控制是否在改(面板底部的"改名");不给 = 自己管 */
  editing?: boolean;
  onEditing?: (on: boolean) => void;
  /** 改名时输入框下面多出来的东西(国家:"AI 起名") */
  extra?: ReactNode;
}

export function NameEdit({ k, kind, eastern, shown, current, fallback, names, preview, hint, big, editing: outer, onEditing, extra }: NameEditProps) {
  const [inner, setInner] = useState(false);
  const editing = outer ?? inner;
  const setEditing = (on: boolean) => {
    setInner(on);
    onEditing?.(on);
  };
  const [text, setText] = useState(current);
  // 刚开始改:初值 = 现在的名字(在渲染时换,输入框一出来就是对的)
  const [was, setWas] = useState(editing);
  if (was !== editing) {
    setWas(editing);
    if (editing) setText(current);
  }
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // 开始改:输入框拿到焦点、全选
  useLayoutEffect(() => {
    if (!editing) return;
    done.current = false;
    input.current?.focus();
    input.current?.select();
  }, [editing]);
  // 选中别的东西时收起输入框
  useEffect(() => {
    if (editing) setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  const renamed = typeof names[k] === 'string' && names[k] !== '';
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const v = cleanName(kind, text, eastern);
    if (v === current) return;
    setName(k, !v || v === fallback ? null : v);
  };
  if (!editing) {
    return (
      <div className={`ins-name-row${big ? ' big' : ''}`}>
        <button className="ins-name" onClick={() => setEditing(true)} title={hint ?? '点一下改名'}>
          {shown}
          <span className="nm-pen" aria-hidden="true" />
        </button>
        {renamed && (
          <button className="ins-reset" onClick={() => setName(k, null)} title={`恢复成生成时的名字:${fallback}`}>
            恢复默认
          </button>
        )}
      </div>
    );
  }
  const v = cleanName(kind, text, eastern);
  return (
    <div className={`ins-edit${big ? ' big' : ''}`}>
      <input
        ref={input}
        value={text}
        maxLength={24}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            e.stopPropagation();
            done.current = true;
            setEditing(false);
          }
        }}
        onBlur={commit}
      />
      <div className="ins-preview">{v ? (preview ? preview(v) : v) : `留空 = 恢复默认(${fallback})`}</div>
      {hint && <div className="ins-hint">{hint}</div>}
      {extra}
    </div>
  );
}
