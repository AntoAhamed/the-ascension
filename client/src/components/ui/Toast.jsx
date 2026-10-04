import { AnimatePresence, m } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Minimal toast system. No dependency — just context + AnimatePresence.
 *
 * Used for API errors and for informational nudges (e.g. decay applied).
 */

const ToastContext = createContext(null);

const ICONS = {
  success: { Icon: CheckCircle2, accent: '#34d399' },
  error: { Icon: AlertTriangle, accent: '#fb7185' },
  info: { Icon: Info, accent: '#22d3ee' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message, { type = 'info', duration = 5000, title } = {}) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, message, type, title }]);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      toast,
      success: (m, o) => toast(m, { ...o, type: 'success' }),
      error: (m, o) => toast(m, { ...o, type: 'error' }),
      info: (m, o) => toast(m, { ...o, type: 'info' }),
      dismiss,
    }),
    [toast, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[10000] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }) {
  const { Icon, accent } = ICONS[toast.type] ?? ICONS.info;

  return (
    <m.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="panel pointer-events-auto flex w-full max-w-sm items-start gap-3 px-4 py-3"
      style={{ borderColor: `${accent}33`, boxShadow: `0 8px 32px -8px ${accent}44` }}
      role="status"
    >
      <Icon size={18} className="mt-0.5 shrink-0" style={{ color: accent }} />
      <div className="min-w-0 flex-1">
        {toast.title && <p className="text-sm font-bold text-slate-100">{toast.title}</p>}
        <p className="text-sm leading-snug text-slate-300">{toast.message}</p>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 text-slate-600 transition-colors hover:bg-white/10 hover:text-slate-300"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </m.div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}