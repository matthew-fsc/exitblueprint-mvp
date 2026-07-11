import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type ToastKind = 'default' | 'good' | 'error';
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, kind: ToastKind = 'default') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="ui-toast-wrap" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`ui-toast ${t.kind === 'good' ? 'ui-toast-good' : t.kind === 'error' ? 'ui-toast-error' : ''}`.trim()}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
