/** 剪贴板(存档菜单的分享链接、分享窗的短链接) */

/** 复制到剪贴板:先用剪贴板接口,不行(没权限、不是 https)再用老办法;都不行 = false */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 换老办法 */
  }
  const focused = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    focused?.focus?.();
  }
}
