// 红果短剧 4.8：界面入口；目录双线与验证范围见 docs/release-4.8.md。
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import './desktop-mist.css';
import './silk-glass.css';
import './skin-frosted.css';
import './skin-soft.css';
import { initializePosterSize, initializeSkin } from './theme';

import { initializeLanguage } from './i18n';

initializePosterSize();
initializeSkin();


// 先以本地存储与系统默认语言同步挂载首屏，随后异步同步主进程区域设置
void initializeLanguage();
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
