// Reusable UI kit (§12 redesign). Small Preact wrappers over the Tailwind
// component classes in index.css. Each control spreads `...rest` onto the REAL
// underlying element so callers' `data-testid`/handlers/value flow through
// unchanged — the Playwright contract (data-testid selectors) is preserved.
import type { ComponentChildren, JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BTN: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

/** A small inline spinner (Tailwind animate-spin), inherits the button's color. */
export function Spinner({ class: cls = '' }: { class?: string }): JSX.Element {
  return (
    <svg class={`h-4 w-4 shrink-0 animate-spin ${cls}`} viewBox="0 0 24 24" fill="none" data-testid="spinner" aria-hidden="true">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0a12 12 0 0 0-8 12h4z" />
    </svg>
  );
}

type ButtonProps = JSX.IntrinsicElements['button'] & { variant?: Variant; size?: 'sm'; loading?: boolean };
/**
 * The standard action button. SERVER-CALLING BUTTONS AUTO-LOCK: if `onClick`
 * returns a Promise (i.e. it makes a server request), the button shows a spinner
 * and disables itself until the promise settles — preventing double-submits and
 * giving clear in-flight feedback, with no per-call-site bookkeeping. To opt in,
 * just let the handler RETURN the promise (`onClick={save}` / `onClick={() => save(id)}`,
 * not `onClick={() => { void save(); }}`). For `type="submit"` buttons (no onClick),
 * pass `loading` explicitly. An explicit `loading` prop always composes too.
 */
export function Button({
  variant = 'primary',
  size,
  loading = false,
  disabled,
  class: cls = '',
  children,
  onClick,
  ...rest
}: ButtonProps): JSX.Element {
  const [autoPending, setAutoPending] = useState(false);
  const busy = loading || autoPending;

  const handleClick = (e: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    if (!onClick) return;
    const result = (onClick as (ev: typeof e) => unknown)(e);
    // An async (server-calling) handler returns a thenable → lock until it settles.
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      setAutoPending(true);
      void Promise.resolve(result).finally(() => setAutoPending(false));
    }
  };

  return (
    <button
      type="button"
      class={`${BTN[variant]} ${size === 'sm' ? 'btn-sm' : ''} ${cls}`}
      // A busy button is disabled, so it can't be double-clicked.
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={handleClick}
      {...rest}
    >
      {busy ? (
        <span class="inline-flex items-center gap-2">
          <Spinner />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}

/** One row in an {@link ActionMenu}. `onSelect` may return a Promise — while it's
 *  in flight the menu stays open, the item shows a spinner, and all items lock
 *  (the standing server-calling-button rule applies inside the menu too). */
export interface ActionMenuItem {
  label: string;
  onSelect: () => void | Promise<void>;
  /** Render in red (destructive). */
  danger?: boolean;
  disabled?: boolean;
  /** Native tooltip (e.g. why the action is disabled). */
  title?: string;
  'data-testid'?: string;
}

/**
 * A kebab (⋮) dropdown that consolidates a set of row actions. Closes on
 * outside-click or Escape. Each item keeps its own `data-testid` so the
 * Playwright contract is preserved — tests just open the menu first.
 */
export function ActionMenu({
  items,
  label = 'Actions',
  'data-testid': testId,
  onOpenChange,
}: {
  items: ActionMenuItem[];
  label?: string;
  'data-testid'?: string;
  /** Notified when the dropdown opens/closes (e.g. to raise the host's z-index). */
  onOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const select = (item: ActionMenuItem): void => {
    if (item.disabled || pending) return;
    const result = item.onSelect();
    // Async (server-calling) action → lock the menu + spin the item until settled.
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      setPending(item.label);
      void Promise.resolve(result).finally(() => {
        setPending(null);
        setOpen(false);
      });
    } else {
      setOpen(false);
    }
  };

  return (
    <div ref={ref} class="relative inline-block text-left">
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        class="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        <svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          class="absolute right-0 z-30 mt-1 min-w-[11rem] overflow-hidden rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              data-testid={item['data-testid']}
              disabled={item.disabled || (pending !== null && pending !== item.label)}
              aria-busy={pending === item.label || undefined}
              title={item.title}
              onClick={() => select(item)}
              class={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger ? 'text-rose-600 hover:bg-rose-50' : 'text-ink-800 hover:bg-stone-50'
              }`}
            >
              {pending === item.label ? <Spinner class={item.danger ? '' : 'text-stone-500'} /> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
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
    <header class="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4">
      <div class="min-w-0">
        <h1 class="text-xl font-bold text-ink-950 sm:text-2xl">{title}</h1>
        {subtitle ? <p class="mt-1 text-sm text-stone-500">{subtitle}</p> : null}
      </div>
      {actions ? <div class="flex flex-wrap items-center gap-2">{actions}</div> : null}
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
  if (['pending', 'warming', 'draft', 'sending', 'onboarding', 'scheduled', 'paused'].some((k) => s.includes(k)))
    return 'warn';
  if (s === 'archived') return 'neutral';
  if (
    ['suspended', 'failed', 'bounce', 'complained', 'mismatch', 'false', 'error', 'refuse'].some((k) =>
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
 * A tiny dependency-free SVG sparkline (a filled area + line). Scales the series
 * to a 100×h viewBox; a flat/empty series renders a baseline. Decorative —
 * aria-hidden, the numbers next to it carry the meaning.
 */
export function Sparkline({
  data,
  class: cls = '',
  stroke = 'currentColor',
  height = 36,
}: {
  data: readonly number[];
  class?: string;
  stroke?: string;
  height?: number;
}): JSX.Element {
  const W = 100;
  const H = height;
  const n = data.length;
  const max = Math.max(1, ...data);
  const pad = 2;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const pts = data.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const line = n ? `M${pts.join(' L')}` : '';
  const area = n ? `M0,${H} L${pts.join(' L')} L${W},${H} Z` : '';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class={`block w-full ${cls}`} style={{ height: `${H}px` }} aria-hidden="true">
      <path d={area} fill={stroke} opacity={0.12} />
      <path d={line} fill="none" stroke={stroke} stroke-width={1.5} vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  );
}

/** Drawer slide/scrim transition duration (ms) — kept in sync with the CSS. */
const DRAWER_ANIM_MS = 300;

/**
 * A right-side sliding drawer with a scrim. Animates IN and OUT: on close it
 * plays the exit transition, then unmounts. Backdrop click + the close button
 * both call onClose. `footer` pins actions to the bottom; `children` scroll.
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
  // `mounted` keeps the DOM around during the exit animation; `visible` drives
  // the in/out transition (translate + opacity). Opening: mount, then flip
  // visible on the next frame so the transition runs. Closing: flip visible off,
  // then unmount after the animation completes.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(r);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), DRAWER_ANIM_MS);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  // Portal to <body> so the overlay escapes any ancestor with a `transform`
  // (e.g. the page's animate-fade-up wrapper), which would otherwise become the
  // containing block for `position: fixed` and clip the drawer to the content.
  return createPortal(
    <div class="fixed inset-0 z-50 flex justify-end" data-testid={testId}>
      <div
        class={`absolute inset-0 bg-ink-950/40 transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        class={`relative z-10 flex h-full w-full max-w-4xl flex-col bg-white shadow-soft transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
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
    </div>,
    document.body,
  );
}

export function EmptyState({ children }: { children: ComponentChildren }): JSX.Element {
  return (
    <div class="rounded-xl border border-dashed border-stone-300 bg-white/50 px-6 py-10 text-center text-sm text-stone-400">
      {children}
    </div>
  );
}
