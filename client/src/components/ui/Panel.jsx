import { m } from 'framer-motion';

/** Frosted container. Every card in the app is built on this. */
export function Panel({ children, className = '', hover = false, delay = 0, ...rest }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`panel ${hover ? 'panel-hover' : ''} ${className}`}
      {...rest}
    >
      {children}
    </m.div>
  );
}

export function PanelHeader({ title, subtitle, icon: Icon, accent = '#22d3ee', right = null }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
      <div className="flex items-center gap-3">
        {Icon && (
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border"
            style={{
              borderColor: `${accent}33`,
              backgroundColor: `${accent}14`,
              color: accent,
            }}
          >
            <Icon size={17} strokeWidth={2.4} />
          </span>
        )}
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-slate-200">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}