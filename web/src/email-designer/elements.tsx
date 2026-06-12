// Canvas element renderers (port of nomentor's rows/*.jsx, narrowed to the email
// model). Each leaf renders an approximation of its compiled MJML output; the
// text element is contenteditable with a floating formatting toolbar (bold/
// italic/underline/lists/link/size) producing inline HTML that mj-text accepts.
import { useRef, useState, useCallback, useEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import {
  dragging,
  selectedId,
  selectNode,
  settings,
  updateElementProps,
  mutate,
  dropOnCell,
  viewportMode,
} from './state.js';
import {
  DEFAULT_CONTENT_PADDING,
  borderCss,
  fontSizeCss,
  headingSizeCss,
  paddingCss,
  radiusCss,
  type Style,
} from './canvas-styles.js';
import type { DesignElement, GridElement, LeafElement } from './model.js';

// ── Text (contenteditable + floating toolbar) ────────────────────────────────

interface RteButton {
  readonly cmd?: string;
  readonly label: string;
  readonly css?: string;
  readonly sep?: boolean;
  readonly prompt?: boolean;
  readonly sizeDelta?: number;
}

const RTE_BUTTONS: readonly RteButton[] = [
  { cmd: 'bold', label: 'B', css: 'font-weight:bold' },
  { cmd: 'italic', label: 'I', css: 'font-style:italic' },
  { cmd: 'underline', label: 'U', css: 'text-decoration:underline' },
  { label: '', sep: true },
  { cmd: 'insertUnorderedList', label: '• list' },
  { cmd: 'insertOrderedList', label: '1. list' },
  { label: '', sep: true },
  { cmd: 'fontSize', label: 'A−', sizeDelta: -1 },
  { cmd: 'fontSize', label: 'A+', sizeDelta: 1 },
  { label: '', sep: true },
  { cmd: 'createLink', label: 'link', prompt: true },
  { cmd: 'unlink', label: 'unlink' },
];

const RTE_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];

function TextEl({ element }: { element: LeafElement & { type: 'text' } }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [showToolbar, setShowToolbar] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const s: Style = { padding: paddingCss(element.props.padding, DEFAULT_CONTENT_PADDING) };
  if (element.props.color) s.color = element.props.color;
  if (element.props.textAlign) s.textAlign = element.props.textAlign;
  if (element.props.lineHeight) s.lineHeight = String(element.props.lineHeight);
  const fs = fontSizeCss(element.props.fontSize, settings.value);
  if (fs) s.fontSize = fs;

  const save = (): void => {
    const html = ref.current?.innerHTML ?? '';
    if (html !== element.props.html) {
      mutate('Edit text', () => updateElementProps(element.id, { html }));
    }
  };

  // The toolbar sits IMMEDIATELY ABOVE the text element, right-aligned with its
  // edge; when that spot scrolls out of the viewport it sticks to the top.
  const position = useCallback((): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const TOOLBAR_H = 38;
    const GAP = 6;
    setPos({
      top: Math.max(8, rect.top - TOOLBAR_H - GAP),
      left: rect.right, // the toolbar right-aligns to this via translateX(-100%)
    });
    setShowToolbar(true);
  }, []);

  // While the toolbar is open, track scrolling/resizing so it follows the text
  // (capture phase — the canvas scrolls in an inner container).
  useEffect(() => {
    if (!showToolbar) return;
    const reposition = (): void => position();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [showToolbar, position]);

  const exec = (btn: RteButton): void => {
    if (btn.sizeDelta) {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const el = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
      const current = el ? parseFloat(getComputedStyle(el).fontSize) || 16 : 16;
      const next =
        btn.sizeDelta > 0
          ? (RTE_SIZES.find((x) => x > current) ?? RTE_SIZES[RTE_SIZES.length - 1])
          : ([...RTE_SIZES].reverse().find((x) => x < current) ?? RTE_SIZES[0]);
      document.execCommand('fontSize', false, '7');
      ref.current?.querySelectorAll('font[size="7"]').forEach((f) => {
        const span = document.createElement('span');
        span.style.fontSize = `${next}px`;
        span.innerHTML = (f as HTMLElement).innerHTML;
        f.replaceWith(span);
      });
    } else if (btn.prompt) {
      const url = prompt('Enter URL:');
      if (url && btn.cmd) document.execCommand(btn.cmd, false, url);
    } else if (btn.cmd) {
      document.execCommand(btn.cmd, false);
    }
    ref.current?.focus();
  };

  // The toolbar is PORTALED to document.body: the app shell animates with a
  // transform, which would otherwise hijack position:fixed (a transformed
  // ancestor becomes the containing block) and strand the toolbar mid-page.
  const toolbar = showToolbar
    ? createPortal(
        <div
          ref={toolbarRef}
          data-testid="rte-toolbar"
          class="nm-rte-toolbar"
          style={{ top: `${pos.top}px`, left: `${pos.left}px`, transform: 'translateX(-100%)' }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {RTE_BUTTONS.map((btn, i) =>
            btn.sep ? (
              <span key={i} class="nm-rte-sep" />
            ) : (
              <button key={btn.label} type="button" class="nm-rte-btn" title={btn.label} onClick={() => exec(btn)}>
                <span style={btn.css}>{btn.label}</span>
              </button>
            ),
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <div class="nm-text-wrap">
      {toolbar}

      <div
        ref={ref}
        data-testid="text-editable"
        class="nm-text-editable"
        contentEditable
        style={s}
        onFocus={position}
        onBlur={(e) => {
          if (toolbarRef.current?.contains(e.relatedTarget as Node)) return;
          setShowToolbar(false);
          save();
        }}
        dangerouslySetInnerHTML={{ __html: element.props.html }}
      />
    </div>
  );
}

// ── Other leaves ─────────────────────────────────────────────────────────────

function HeadingEl({ element }: { element: LeafElement & { type: 'heading' } }): JSX.Element {
  const p = element.props;
  const Tag = p.level;
  const s: Style = {
    margin: '0',
    padding: paddingCss(p.padding, DEFAULT_CONTENT_PADDING),
    fontSize: headingSizeCss(p.level, settings.value),
    fontWeight: '700',
  };
  if (p.color) s.color = p.color;
  if (p.textAlign) s.textAlign = p.textAlign;
  return <Tag style={s}>{p.text}</Tag>;
}

function ImageEl({ element }: { element: LeafElement & { type: 'image' } }): JSX.Element {
  const p = element.props;
  const wrap: Style = { padding: paddingCss(p.padding, DEFAULT_CONTENT_PADDING), textAlign: p.align ?? 'center' };
  if (!p.src) {
    return (
      <div class="nm-image-placeholder" style={wrap}>
        <span>Pick an image in the properties panel</span>
      </div>
    );
  }
  const img: Style = { maxWidth: '100%', display: 'inline-block' };
  if (p.width) img.width = `${p.width}px`;
  const r = radiusCss(p.radius);
  if (r) img.borderRadius = r;
  return (
    <div style={wrap}>
      <img src={p.src} alt={p.alt ?? ''} style={img} />
    </div>
  );
}

function ButtonEl({ element }: { element: LeafElement & { type: 'button' } }): JSX.Element {
  const p = element.props;
  const wrap: Style = { padding: paddingCss(p.padding, DEFAULT_CONTENT_PADDING), textAlign: p.align ?? 'center' };
  const btn: Style = {
    display: 'inline-block',
    padding: '10px 25px',
    backgroundColor: p.bgColor ?? '#4a90d9',
    color: p.color ?? '#ffffff',
    borderRadius: `${p.borderRadius ?? 3}px`,
    textDecoration: 'none',
    fontWeight: '400',
  };
  const fs = fontSizeCss(p.fontSize, settings.value);
  if (fs) btn.fontSize = fs;
  return (
    <div style={wrap}>
      <a href={p.url || '#'} style={btn} onClick={(e) => e.preventDefault()}>
        {p.text || 'Button'}
      </a>
    </div>
  );
}

function ListEl({ element }: { element: LeafElement & { type: 'list' } }): JSX.Element {
  const p = element.props;
  const dir = settings.value.direction === 'rtl' ? 'rtl' : 'ltr';
  const wrap: Style = { padding: paddingCss(p.padding, DEFAULT_CONTENT_PADDING) };
  if (p.color) wrap.color = p.color;
  if (p.textAlign) wrap.textAlign = p.textAlign;
  const fs = fontSizeCss(p.fontSize, settings.value);
  if (fs) wrap.fontSize = fs;
  const listStyle: Style = { margin: '0', padding: dir === 'rtl' ? '0 24px 0 0' : '0 0 0 24px' };
  const Tag = p.listType === 'ol' ? 'ol' : 'ul';
  return (
    <div style={wrap}>
      <Tag style={listStyle}>
        {p.items.map((i) => (
          <li key={i.id}>{i.text}</li>
        ))}
      </Tag>
    </div>
  );
}

function SeparatorEl({ element }: { element: LeafElement & { type: 'separator' } }): JSX.Element {
  const p = element.props;
  const wrap: Style = { padding: paddingCss(p.padding, DEFAULT_CONTENT_PADDING) };
  const hr: Style = {
    border: 'none',
    borderTop: `${p.lineThickness ?? 1}px ${p.lineStyle ?? 'solid'} ${p.lineColor ?? '#dddddd'}`,
    margin: '0 auto',
    width: p.lineWidth ? `${p.lineWidth}%` : '100%',
  };
  return (
    <div style={wrap}>
      <hr style={hr} />
    </div>
  );
}

// ── Grid ─────────────────────────────────────────────────────────────────────

function GridEl({ element }: { element: GridElement }): JSX.Element {
  // Mobile preview stacks columns full-width — exactly what MJML's compiled
  // output does below its responsive breakpoint.
  const stacked = viewportMode.value === 'mobile';
  return (
    <div class="nm-grid" style={{ display: 'flex', width: '100%', flexDirection: stacked ? 'column' : 'row' }}>
      {element.children.map((cell) => {
        const p = cell.props ?? {};
        const s: Style = {
          flex: stacked ? '1 1 auto' : p.width ? `0 0 ${p.width}%` : '1 1 0',
          padding: paddingCss(p.padding, '0'),
        };
        if (p.bgColor) s.backgroundColor = p.bgColor;
        const b = borderCss(p.border);
        if (b) s.border = b;
        const r = radiusCss(p.radius);
        if (r) s.borderRadius = r;
        const isSel = selectedId.value === cell.id;
        return (
          <div
            key={cell.id}
            data-testid="grid-cell"
            data-node-id={cell.id}
            class={`nm-grid-cell ${isSel ? 'nm-selected' : ''}`}
            style={s}
            onClick={(e) => {
              e.stopPropagation();
              selectNode(cell.id);
            }}
            onDragOver={(e) => {
              if (dragging.value && dragging.value.type !== 'grid') {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onDrop={(e) => {
              if (!dragging.value || dragging.value.type === 'grid') return;
              e.preventDefault();
              e.stopPropagation();
              dropOnCell(dragging.value.type, cell.id);
              dragging.value = null;
            }}
          >
            {cell.elements.length === 0 ? <div class="nm-cell-empty">Drop here</div> : null}
            {cell.elements.map((el) => (
              <ElementRenderer key={el.id} element={el} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export function ElementRenderer({ element }: { element: DesignElement }): JSX.Element {
  const isSelected = selectedId.value === element.id;
  return (
    <div
      data-testid="canvas-element"
      data-node-id={element.id}
      data-el-type={element.type}
      class={`nm-element ${isSelected ? 'nm-selected' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        selectNode(element.id);
      }}
    >
      <div class="nm-element-label">{element.type}</div>
      {element.type === 'heading' ? (
        <HeadingEl element={element} />
      ) : element.type === 'text' ? (
        <TextEl element={element} />
      ) : element.type === 'image' ? (
        <ImageEl element={element} />
      ) : element.type === 'button' ? (
        <ButtonEl element={element} />
      ) : element.type === 'list' ? (
        <ListEl element={element} />
      ) : element.type === 'separator' ? (
        <SeparatorEl element={element} />
      ) : (
        <GridEl element={element} />
      )}
    </div>
  );
}
