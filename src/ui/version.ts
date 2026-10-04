/**
 * 网站的版本号(侧栏"更多"菜单底部、概览底部那行小字里显示)。
 * 构建时由 vite.config.ts 从 package.json 的 version 填进来;直接在 Node 里跑(检查脚本)时没有,显示 dev。
 */
declare const __APP_VERSION__: string | undefined;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
