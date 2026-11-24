// 红果短剧 4.8：界面入口；目录双线与验证范围见 docs/release-4.8.md。
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import './desktop-mist.css';
import './silk-glass.css';
import './skin-frosted.css';
import { initializePosterSize, initializeSkin } from './theme';

import { initializeLanguage } from './i18n';

initializePosterSize();
initializeSkin();


initializeLanguage().then(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
));
