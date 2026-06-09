// Minimal inline stroke icons for the sidebar nav (no icon-font dependency).
import type { JSX } from 'preact';

function I({ d, children }: { d?: string; children?: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-[18px] w-[18px] shrink-0"
      aria-hidden="true"
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export const ICONS: Record<string, JSX.Element> = {
  dashboards: <I d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z" />,
  segments: (
    <I>
      <circle cx="7" cy="7" r="4" />
      <circle cx="17" cy="17" r="4" />
      <path d="M11 7h6M7 11v6" />
    </I>
  ),
  broadcasts: <I d="M3 11l18-7-7 18-2.5-7.5L3 11Z" />,
  campaigns: (
    <I>
      <circle cx="5" cy="6" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="12" r="2" />
      <path d="M7 6h6a4 4 0 0 1 4 4M7 18h6a4 4 0 0 0 4-4" />
    </I>
  ),
  editor: <I d="M4 20h16M4 16l9-9 4 4-9 9H4v-4Zm9-9 2-2 4 4-2 2" />,
  profiles: (
    <I>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </I>
  ),
  suppressions: (
    <I>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 6l12 12" />
    </I>
  ),
  billing: <I d="M3 7h18v10H3V7Zm0 4h18M7 15h3" />,
  company: (
    <I>
      <path d="M3 21h18M5 21V6l7-3 7 3v15" />
      <path d="M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01" />
    </I>
  ),
  settings: (
    <I>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </I>
  ),
  activity: <I d="M3 12h4l3 8 4-16 3 8h4" />,
  onboarding: <I d="M4 7h16M4 12h16M4 17h10M19 15l2 2-2 2" />,
  admin: <I d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" />,
  help: (
    <I>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" />
      <path d="M12 17h.01" />
    </I>
  ),
};
