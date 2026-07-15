import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted variable fonts (bundled at build time — no runtime network
// dependency, so the app stays offline/CI-safe while actually rendering in the
// typeface it was designed around instead of a system fallback). Inter for
// body/UI, Inter Tight for display headings.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter-tight/wght.css';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
