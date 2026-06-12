// Lucide icon components — ported verbatim from nomentor's editor/src/icons.jsx
// (stroke-based, consistent 24x24 viewBox), narrowed to the email designer's set.
import type { JSX } from 'preact';

interface IconProps {
  readonly size?: number;
}

const I = ({ size = 20 }: IconProps, paths: JSX.Element): JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {paths}
  </svg>
);

export const Grid = (p: IconProps = {}): JSX.Element =>
  I(p, <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /></>);
export const Heading = (p: IconProps = {}): JSX.Element =>
  I(p, <><path d="M6 12h12" /><path d="M6 20V4" /><path d="M18 20V4" /></>);
export const AlignLeft = (p: IconProps = {}): JSX.Element =>
  I(p, <><path d="M17 6.1H3" /><path d="M21 12.1H3" /><path d="M15.1 18H3" /></>);
export const Image = (p: IconProps = {}): JSX.Element =>
  I(p, <><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></>);
export const List = (p: IconProps = {}): JSX.Element =>
  I(p, <><line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" /><line x1="8" x2="21" y1="18" y2="18" /><line x1="3" x2="3.01" y1="6" y2="6" /><line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" /></>);
export const MousePointerClick = (p: IconProps = {}): JSX.Element =>
  I(p, <><rect width="18" height="10" x="3" y="7" rx="5" /><path d="M7 12h10" /></>);
export const UnfoldVertical = (p: IconProps = {}): JSX.Element =>
  I(p, <><path d="M12 22v-6" /><path d="M12 8V2" /><path d="M4 12h16" /><path d="m15 19-3 3-3-3" /><path d="m15 5-3-3-3 3" /></>);
export const Undo = (p: IconProps = {}): JSX.Element =>
  I(p, <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>);
export const Redo = (p: IconProps = {}): JSX.Element =>
  I(p, <><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>);
export const Clock = (p: IconProps = {}): JSX.Element =>
  I(p, <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>);
export const Monitor = (p: IconProps = {}): JSX.Element =>
  I(p, <><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></>);
export const Tablet = (p: IconProps = {}): JSX.Element =>
  I(p, <><rect width="16" height="20" x="4" y="2" rx="2" ry="2" /><line x1="12" x2="12.01" y1="18" y2="18" /></>);
export const Smartphone = (p: IconProps = {}): JSX.Element =>
  I(p, <><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></>);
