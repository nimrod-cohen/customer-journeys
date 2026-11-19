// Shared layout for the public legal pages (/privacy, /terms): readable WITHOUT
// logging in, rendered by App before its auth gate.
import type { ComponentChildren } from 'preact';

export function LegalPage(props: {
  title: string;
  updated: string;
  testid: string;
  children: ComponentChildren;
}) {
  return (
    <div class="min-h-dvh bg-stone-50 text-ink-900">
      <header class="border-b border-stone-200 bg-surface">
        <div class="mx-auto flex max-w-3xl items-center justify-between gap-2.5 px-6 py-4">
          <div class="flex items-center gap-2.5">
            <span class="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-ink-950">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                class="h-5 w-5"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M3 12c4-7 14-7 18 0-4 7-14 7-18 0Z" stroke-linejoin="round" />
                <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <div class="font-display text-[15px] font-bold text-ink-950">Customer Journeys</div>
          </div>
          <a
            data-testid={`${props.testid}-back-home`}
            href="/"
            class="text-sm font-semibold text-brand-700 hover:underline"
          >
            ← Back to homepage
          </a>
        </div>
      </header>
      <main class="mx-auto max-w-3xl px-6 py-8" data-testid={props.testid}>
        <h1 class="mb-1 font-display text-2xl font-bold text-ink-950">{props.title}</h1>
        <p class="text-sm text-stone-500">Last updated: {props.updated}</p>
        {props.children}
      </main>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="mt-8">
      <h2 class="mb-2 font-display text-lg font-bold text-ink-950">{title}</h2>
      <div class="space-y-3 text-sm leading-relaxed text-stone-700">{children}</div>
    </section>
  );
}

export function List({ items }: { items: ComponentChildren[] }) {
  return (
    <ul class="list-disc space-y-1.5 ps-5">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

export function Intro({ children }: { children: ComponentChildren }) {
  return <div class="mt-6 space-y-3 text-sm leading-relaxed text-stone-700">{children}</div>;
}

export const LEGAL_CONTACT = 'privacy@on-grow.com';

export function MailLink({ to = LEGAL_CONTACT }: { to?: string }) {
  return (
    <a href={`mailto:${to}`} class="font-semibold text-brand-700 hover:underline">
      {to}
    </a>
  );
}
