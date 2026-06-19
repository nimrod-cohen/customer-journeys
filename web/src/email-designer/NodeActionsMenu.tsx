// Per-node actions menu (Duplicate / Delete) for the Structure navigator. The
// trigger is a small round "⋮" icon button sitting on every tree item; clicking
// it opens a dropdown. The dropdown is PORTALED to <body> with fixed positioning
// anchored to the button, because the navigator scrolls (overflow-y:auto) and an
// absolutely-positioned menu inside it would be clipped. Closes on outside click,
// Escape, or any scroll (which would otherwise leave the menu floating).
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Copy, Trash2, MoreVertical } from './icons.tsx';

const MENU_WIDTH = 160;

export function NodeActionsMenu({
  onDuplicate,
  onDelete,
  label = 'Actions',
}: {
  /** Omit to show a delete-only menu (e.g. grid columns, which can't duplicate). */
  onDuplicate?: () => void;
  onDelete: () => void;
  /** Accessible label for the trigger (the icon has no visible text). */
  label?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    // Any scroll (navigator or window) would drift the anchored menu → just close.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = (e: MouseEvent): void => {
    e.stopPropagation(); // don't select the node / trip the outside-click close
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // Below the button, right edges aligned, clamped into the viewport.
      const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        class="nm-icon-menu-btn"
        data-testid="node-actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        draggable={false}
        onClick={toggle}
      >
        <MoreVertical size={14} />
      </button>
      {open
        ? createPortal(
            <div
              class="nm-menu nm-menu-fixed"
              role="menu"
              style={{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${MENU_WIDTH}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              {onDuplicate ? (
                <button
                  type="button"
                  role="menuitem"
                  class="nm-menu-item"
                  data-testid="duplicate-node"
                  onClick={() => {
                    setOpen(false);
                    onDuplicate();
                  }}
                >
                  <Copy size={13} /> Duplicate
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                class="nm-menu-item nm-danger"
                data-testid="delete-node"
                onClick={() => {
                  setOpen(false);
                  onDelete();
                }}
              >
                <Trash2 size={13} /> Delete
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
