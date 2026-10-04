import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/app.css';
// 宽屏、手机的布局放在最后,盖过各处的默认样式
import './ui/desktop.css';
import './ui/phone.css';

createRoot(document.getElementById('root')!).render(<App />);
