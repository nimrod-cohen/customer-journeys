// Reusable UI kit (§12 redesign). Small Preact wrappers over the Tailwind
// component classes in index.css. Each control spreads `...rest` onto the REAL
// underlying element so callers' `data-testid`/handlers/value flow through
// unchanged — the Playwright contract (data-testid selectors) is preserved.
import type { ComponentChildren, JSX } from 'preact';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BTN: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

type ButtonProps = JSX.IntrinsicElements['button'] & { variant?: Variant; size?: 'sm' };
export function Button({ variant = 'primary', size, class: cls = '', children, ...rest }: ButtonProps): JSX.Element {
  return (
    <button type="button" class={`${BTN[variant]} ${size === 'sm' ? 'btn-sm' : ''} ${cls}`} {...rest}>
      {children}
    </button>
  );
}

export function Input({ class: cls = '', ...rest }: JSX.IntrinsicElements['input']): JSX.Element {
  return <input class={`input ${cls}`} {...rest} />;
}

export function Textarea({ class: cls = '', ...rest }: JSX.IntrinsicElements['textarea']): JSX.Element {
  return <textarea class={`textarea ${cls}`} rows={4} {...rest} />;
}

export function Select({ class: cls = '', children, ...rest }: JSX.IntrinsicElements['select']): JSX.Element {
  return (
    <select class={`select ${cls}`} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
  class: cls = '',
}: {
  label?: string;
  hint?: string;
  children: ComponentChildren;
  class?: string;
}): JSX.Element {
  return (
    <div class={cls}>
      {label ? <span class="label">{label}</span> : null}
      {children}
      {hint ? <p class="mt-1 text-xs text-stone-400">{hint}</p> : null}
    </div>
  );
}

export function Card({ class: cls = '', children, ...rest }: JSX.IntrinsicElements['div']): JSX.Element {
  return (
    <div class={`card ${cls}`} {...rest}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ComponentChildren;
}): JSX.Element {
  return (
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-ink-950">{title}</h1>
        {subtitle ? <p class="mt-1 text-sm text-stone-500">{subtitle}</p> : null}
      </div>
      {actions ? <div class="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type Tone = 'neutral' | 'success' | 'warn' | 'danger';
const BADGE: Record<Tone, string> = {
  neutral: 'badge-neutral',
  success: 'badge-success',
  warn: 'badge-warn',
  danger: 'badge-danger',
};

export function Badge({ tone = 'neutral', children, ...rest }: JSX.IntrinsicElements['span'] & { tone?: Tone }): JSX.Element {
  return (
    <span class={BADGE[tone]} {...rest}>
      <span class="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {children}
    </span>
  );
}

/** Map a free-text status to a badge tone (sensible defaults across screens). */
export function toneFor(status: string | undefined | null): Tone {
  const s = (status ?? '').toLowerCase();
  if (['active', 'sent', 'verified', 'true', 'found', 'ok', 'completed', 'success'].some((k) => s.includes(k)))
    return 'success';
  if (['pending', 'warming', 'draft', 'sending', 'onboarding', 'scheduled'].some((k) => s.includes(k)))
    return 'warn';
  if (
    ['suspended', 'failed', 'bounced', 'complained', 'mismatch', 'false', 'error', 'refuse'].some((k) =>
      s.includes(k),
    )
  )
    return 'danger';
  return 'neutral';
}

export function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: ComponentChildren;
  testId?: string;
}): JSX.Element {
  return (
    <Card class="p-5">
      <p class="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
      <p class="mt-2 font-display text-3xl font-bold text-ink-950" data-testid={testId}>
        {value}
      </p>
    </Card>
  );
}

/**
 * A right-side sliding drawer with a scrim. Renders nothing when closed.
 * Backdrop click + the close button both call onClose. `footer` pins actions to
 * the bottom; `children` scroll.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  testId?: string;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div class="fixed inset-0 z-50 flex justify-end" data-testid={testId}>
      <div class="absolute inset-0 bg-ink-950/40 animate-fade-in" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        class="relative z-10 flex h-full w-full max-w-md flex-col bg-white shadow-soft animate-slide-in-right"
      >
        <header class="flex items-start justify-between gap-3 border-b border-stone-100 px-5 py-4">
          <div>
            <h2 class="text-base font-bold text-ink-900">{title}</h2>
            {subtitle ? <p class="mt-0.5 text-sm text-stone-500">{subtitle}</p> : null}
          </div>
          <button
            data-testid="drawer-close"
            type="button"
            aria-label="Close"
            onClick={onClose}
            class="-mr-1 rounded-lg p-1.5 text-stone-400 transition hover:bg-stone-100 hover:text-ink-900"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="h-5 w-5">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer class="flex items-center justify-end gap-2 border-t border-stone-100 bg-stone-50/60 px-5 py-4">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

export function EmptyState({ children }: { children: ComponentChildren }): JSX.Element {
  return (
    <div class="rounded-xl border border-dashed border-stone-300 bg-white/50 px-6 py-10 text-center text-sm text-stone-400">
      {children}
    </div>
  );
}
