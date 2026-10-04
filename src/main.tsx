import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/app.css';
// 宽屏布局放在最后,盖过各处的默认样式
import './ui/desktop.css';

createRoot(document.getElementById('root')!).render(<App />);
