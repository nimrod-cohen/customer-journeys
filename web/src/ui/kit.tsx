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

/**
 * A Textarea with a small LTR/RTL writing-direction switcher in the top-right —
 * for composing text (e.g. SMS/WhatsApp bodies) in mixed Hebrew/English. The
 * direction is purely a composing aid (it sets the textarea `dir`; the stored
 * value is unchanged) and is REMEMBERED across sessions per `storageKey`. Spreads
 * `...rest` onto the real <textarea> so `data-testid`/value/handlers flow through.
 */
export function DirectionalTextarea({
  class: cls = '',
  defaultDir = 'rtl',
  storageKey,
  testIdPrefix,
  ...rest
}: JSX.IntrinsicElements['textarea'] & {
  defaultDir?: 'ltr' | 'rtl';
  storageKey?: string;
  testIdPrefix?: string;
}): JSX.Element {
  const key = storageKey ? `cdp.textDir:${storageKey}` : undefined;
  const [dir, setDir] = useState<'ltr' | 'rtl'>(() => {
    if (key && typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(key);
      if (saved === 'ltr' || saved === 'rtl') return saved;
    }
    return defaultDir;
  });
  const choose = (next: 'ltr' | 'rtl') => {
    setDir(next);
    if (key && typeof localStorage !== 'undefined') localStorage.setItem(key, next);
  };
  const segBtn = (d: 'ltr' | 'rtl', label: string) => (
    <button
      type="button"
      data-testid={testIdPrefix ? `${testIdPrefix}-${d}` : undefined}
      aria-pressed={dir === d}
      onClick={() => choose(d)}
      class={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
        dir === d ? 'bg-white text-stone-800 shadow-sm' : 'text-stone-500 hover:text-stone-700'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div>
      <div class="mb-1 flex items-center justify-end gap-1">
        <span class="mr-1 text-xs text-stone-400">Direction</span>
        <div
          data-testid={testIdPrefix ? `${testIdPrefix}-toggle` : undefined}
          class="inline-flex items-center gap-0.5 rounded-md bg-stone-100 p-0.5"
        >
          {segBtn('ltr', 'LTR')}
          {segBtn('rtl', 'RTL')}
        </div>
      </div>
      <textarea class={`textarea ${cls}`} rows={4} dir={dir} {...rest} />
    </div>
  );
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
  back,
  compact,
}: {
  title: string;
  subtitle?: string;
  actions?: ComponentChildren;
  /** Back link rendered on the right side of the title row, vertically centered. */
  back?: ComponentChildren;
  /** Trims the header's bottom margin — for screens (e.g. automation builder)
   *  where the content immediately below is tight and the default mb-6 wastes
   *  too much vertical space. */
  compact?: boolean;
}): JSX.Element {
  // Title (1fr) + right-side controls (max-content) on a single row, vertically
  // centered. Right side stacks back-link first, then actions. On narrow screens
  // the whole header reflows into a column.
  return (
    <header class={`${compact ? 'mb-3' : 'mb-6'} flex flex-col gap-3 sm:grid sm:[grid-template-columns:minmax(0,1fr)_max-content] sm:items-center sm:gap-4`}>
      <div class="min-w-0">
        <h1 class="text-xl font-bold text-ink-950 sm:text-2xl">{title}</h1>
        {subtitle ? <p class="mt-1 text-sm text-stone-500">{subtitle}</p> : null}
      </div>
      {back || actions ? (
        <div class="flex flex-wrap items-center justify-end gap-2">
          {back}
          {actions}
        </div>
      ) : null}
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

/**
 * A toggle SWITCH (an accessible sr-only checkbox + track + knob). Extracted from
 * the copies scattered across the profile screens; the caller supplies a
 * `data-testid` (spread onto the real <input>, preserving the Playwright contract)
 * plus checked/onChange, and optionally a tone + size + disabled/title. Wrap-free
 * (renders its own <label>) so it drops into a flex row.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  tone = 'brand',
  size = 'md',
  title,
  ...rest
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  tone?: 'brand' | 'emerald' | 'rose';
  size?: 'sm' | 'md';
  title?: string;
} & Omit<JSX.IntrinsicElements['input'], 'onChange' | 'checked' | 'type' | 'size' | 'disabled'>): JSX.Element {
  const on = { brand: 'peer-checked:bg-brand-500', emerald: 'peer-checked:bg-emerald-500', rose: 'peer-checked:bg-rose-500' }[tone];
  const track = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
  const knob = size === 'sm' ? 'h-4 w-4 peer-checked:translate-x-4' : 'h-5 w-5 peer-checked:translate-x-5';
  return (
    <label class="relative inline-flex shrink-0 cursor-pointer items-center" title={title}>
      <input
        type="checkbox"
        class="peer sr-only disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        {...rest}
      />
      <span class={`${track} rounded-full bg-stone-300 transition-colors peer-focus:ring-2 peer-focus:ring-brand-400/40 ${on}`} />
      <span class={`absolute left-0.5 top-0.5 ${knob} rounded-full bg-white shadow transition-transform`} />
    </label>
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

/**
 * Numbered-page pagination control: "1–50 of 1,000" + ‹ Prev · page numbers · Next ›.
 * Controlled — the owner holds `page` and reloads on `onPage`. Shows a windowed set of
 * page buttons around the current page so it stays compact at large totals.
 *
 * Renders top AND bottom of a list: pass `testid` to disambiguate the two instances
 * (default 'pagination'; child testids derive from it — `${testid}-summary/-prev/-next/
 * -number`). By default it hides when there's a single page; pass `alwaysShowSummary`
 * (used at the TOP) to keep the "N total" count visible even on one page (the nav buttons
 * still only appear when there's more than one page). An empty list renders nothing.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  alwaysShowSummary = false,
  testid = 'pagination',
  class: cls,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  alwaysShowSummary?: boolean;
  testid?: string;
  class?: string;
}): JSX.Element | null {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (total === 0) return null;
  const multi = pageCount > 1;
  if (!multi && !alwaysShowSummary) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  // A compact window of page numbers around the current page (±2), always incl. 1 + last.
  const nums: number[] = [];
  const push = (n: number): void => {
    if (n >= 1 && n <= pageCount && !nums.includes(n)) nums.push(n);
  };
  push(1);
  for (let n = page - 2; n <= page + 2; n++) push(n);
  push(pageCount);
  nums.sort((a, b) => a - b);

  const btn = 'min-w-8 rounded-md border px-2 py-1 text-sm transition-colors disabled:opacity-40';
  return (
    <div data-testid={testid} class={cls ?? 'mt-4 flex flex-wrap items-center justify-between gap-3'}>
      <span data-testid={`${testid}-summary`} class="text-xs text-stone-500">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      {multi ? (
        <div class="flex items-center gap-1">
          <button
            data-testid={`${testid}-prev`}
            class={`${btn} border-stone-300 hover:border-brand-400`}
            disabled={page <= 1}
            aria-label="Previous page"
            onClick={() => onPage(page - 1)}
          >
            ‹
          </button>
          {nums.map((n, i) => {
            const gap = i > 0 && n - nums[i - 1]! > 1;
            return (
              <span key={n} class="flex items-center gap-1">
                {gap ? <span class="px-1 text-stone-400">…</span> : null}
                <button
                  data-testid={`${testid}-number`}
                  data-page={n}
                  aria-current={n === page ? 'page' : undefined}
                  class={`${btn} ${
                    n === page ? 'border-brand-500 bg-brand-500 font-semibold text-white' : 'border-stone-300 hover:border-brand-400'
                  }`}
                  onClick={() => onPage(n)}
                >
                  {n}
                </button>
              </span>
            );
          })}
          <button
            data-testid={`${testid}-next`}
            class={`${btn} border-stone-300 hover:border-brand-400`}
            disabled={page >= pageCount}
            aria-label="Next page"
            onClick={() => onPage(page + 1)}
          >
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}
