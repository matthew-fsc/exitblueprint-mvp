import { useState } from 'react';
import HealthPage from './pages/HealthPage';
import VerifyPage from './pages/VerifyPage';

const views = ['Health', 'Phase 1 verification'] as const;

export default function App() {
  const [view, setView] = useState<(typeof views)[number]>('Phase 1 verification');
  return (
    <main className="page">
      <header className="page-header">
        <h1>Exit Blueprint</h1>
        <nav className="view-nav">
          {views.map((v) => (
            <button
              key={v}
              className={v === view ? 'view-tab view-tab-active' : 'view-tab'}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </nav>
      </header>
      {view === 'Health' ? <HealthPage /> : <VerifyPage />}
    </main>
  );
}
