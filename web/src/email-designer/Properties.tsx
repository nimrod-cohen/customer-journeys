// The properties panel (port of nomentor's Properties.jsx + properties/shared.jsx,
// narrowed to the email model). Shows type-specific editors for the selected
// row / element / grid cell. Every commit goes through mutate() so it is undoable
// and notifies the host.
import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';
import {
  selectedId,
  settings,
  findRow,
  findElement,
  findCell,
  parentGridOfCell,
  updateRowProps,
  updateElementProps,
  updateCellProps,
  addGridCell,
  removeGridCell,
  mutate,
} from './state.js';
import { FONT_SIZE_EMS, type Align, type Border, type Radius, type Spacing } from './model.js';
import { AssetPicker } from './AssetPicker.tsx';
import { ImageEditor } from './ImageEditor.tsx';
import { AlignLeft, AlignCenter, AlignRight } from './icons.tsx';
import { Crop } from 'lucide-preact';

type Patch = Record<string, unknown>;

// ── Shared field editors ─────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ComponentChildren }): JSX.Element {
  return (
    <label class="nm-prop-field">
      <span class="nm-prop-label">{label}</span>
      {children}
    </label>
  );
}

function TextField({ label, value, onCommit, testId }: { label: string; value: string; onCommit: (v: string) => void; testId?: string }): JSX.Element {
  return (
    <Field label={label}>
      <input
        data-testid={testId}
        class="nm-prop-input"
        type="text"
        value={value}
        onChange={(e) => onCommit((e.target as HTMLInputElement).value)}
      />
    </Field>
  );
}

function NumberField({ label, value, onCommit, placeholder }: { label: string; value: number | undefined; onCommit: (v: number | undefined) => void; placeholder?: string }): JSX.Element {
  return (
    <Field label={label}>
      <input
        class="nm-prop-input"
        type="number"
        value={value ?? ''}
        placeholder={placeholder ?? 'auto'}
        onChange={(e) => {
          const raw = (e.target as HTMLInputElement).value;
          onCommit(raw === '' ? undefined : Number(raw));
        }}
      />
    </Field>
  );
}

function SelectField({ label, value, options, onCommit }: { label: string; value: string; options: ReadonlyArray<readonly [string, string]>; onCommit: (v: string) => void }): JSX.Element {
  return (
    <Field label={label}>
      <select class="nm-prop-input" value={value} onChange={(e) => onCommit((e.target as HTMLSelectElement).value)}>
        {options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ColorField({ label, value, onCommit }: { label: string; value: string | undefined; onCommit: (v: string | undefined) => void }): JSX.Element {
  const palette = settings.value.colors ?? [];
  return (
    <Field label={label}>
      <div class="nm-color-field">
        <input type="color" value={value ?? '#000000'} onChange={(e) => onCommit((e.target as HTMLInputElement).value)} />
        <input
          class="nm-prop-input"
          type="text"
          value={value ?? ''}
          placeholder="inherit"
          onChange={(e) => onCommit((e.target as HTMLInputElement).value || undefined)}
        />
        {value ? (
          <button type="button" class="nm-mini-btn" title="Clear" onClick={() => onCommit(undefined)}>
            ✕
          </button>
        ) : null}
      </div>
      {palette.length ? (
        <div class="nm-palette-chips">
          {palette.map((c) => (
            <button key={c.name} type="button" class="nm-palette-chip" title={c.name} style={{ backgroundColor: c.value }} onClick={() => onCommit(c.value)} />
          ))}
        </div>
      ) : null}
    </Field>
  );
}

function AlignField({ value, onCommit }: { value: Align | undefined; onCommit: (v: Align) => void }): JSX.Element {
  return (
    <Field label="Align">
      <div class="nm-align-group">
        {(['left', 'center', 'right'] as const).map((a) => (
          <button
            key={a}
            type="button"
            class={`nm-mini-btn ${value === a ? 'nm-active' : ''}`}
            data-testid={`align-${a}`}
            onClick={() => onCommit(a)}
            title={`Align ${a}`}
          >
            {a === 'left' ? <AlignLeft size={14} /> : a === 'center' ? <AlignCenter size={14} /> : <AlignRight size={14} />}
          </button>
        ))}
      </div>
    </Field>
  );
}

function PaddingField({ value, onCommit }: { value: Spacing | undefined; onCommit: (v: Spacing | undefined) => void }): JSX.Element {
  const v = value ?? {};
  const set = (side: keyof Spacing, raw: string): void => {
    const n = raw === '' ? undefined : Number(raw);
    const next = { ...v, [side]: n };
    const empty = !next.top && !next.right && !next.bottom && !next.left;
    onCommit(empty ? undefined : next);
  };
  return (
    <Field label="Padding (px)">
      <div class="nm-spacing-grid">
        {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
          <input
            key={side}
            class="nm-prop-input"
            type="number"
            min={0}
            placeholder={side[0]!.toUpperCase()}
            title={side}
            value={v[side] ?? ''}
            onChange={(e) => set(side, (e.target as HTMLInputElement).value)}
          />
        ))}
      </div>
    </Field>
  );
}

function BorderField({ value, onCommit }: { value: Border | undefined; onCommit: (v: Border | undefined) => void }): JSX.Element {
  const v = value ?? {};
  const set = (patch: Record<string, unknown>): void => {
    const next = { ...v, ...patch } as Border;
    onCommit(!next.width || next.style === 'none' ? undefined : next);
  };
  return (
    <Field label="Border">
      <div class="nm-border-grid">
        <input class="nm-prop-input" type="number" min={0} placeholder="W" title="width px" value={v.width ?? ''} onChange={(e) => set({ width: Number((e.target as HTMLInputElement).value) || 0 })} />
        <select class="nm-prop-input" value={v.style ?? 'solid'} onChange={(e) => set({ style: (e.target as HTMLSelectElement).value as Border['style'] })}>
          <option value="solid">solid</option>
          <option value="dashed">dashed</option>
          <option value="dotted">dotted</option>
          <option value="none">none</option>
        </select>
        <input type="color" value={v.color ?? '#000000'} onChange={(e) => set({ color: (e.target as HTMLInputElement).value })} />
      </div>
    </Field>
  );
}

function RadiusField({ value, onCommit }: { value: Radius | undefined; onCommit: (v: Radius | undefined) => void }): JSX.Element {
  const v = value ?? {};
  const uniform = v.topLeft ?? 0;
  return (
    <Field label="Corner radius (px)">
      <input
        class="nm-prop-input"
        type="number"
        min={0}
        value={uniform || ''}
        placeholder="0"
        onChange={(e) => {
          const n = Number((e.target as HTMLInputElement).value) || 0;
          onCommit(n ? { topLeft: n, topRight: n, bottomRight: n, bottomLeft: n } : undefined);
        }}
      />
    </Field>
  );
}

const FONT_SIZE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['', 'default'],
  ...Object.keys(FONT_SIZE_EMS).map((k) => [k, k] as const),
];

// ── Panels per node kind ─────────────────────────────────────────────────────

export function Properties(): JSX.Element {
  const id = selectedId.value;
  if (!id) {
    return (
      <div data-testid="designer-properties" class="nm-props">
        <div class="nm-panel-title">Properties</div>
        <p class="nm-props-empty">Select a row or element on the canvas.</p>
      </div>
    );
  }
  const row = findRow(id);
  if (row) return <RowPanel id={id} />;
  const cell = findCell(id);
  if (cell) return <CellPanel id={id} />;
  const el = findElement(id);
  if (el) return <ElementPanel id={id} />;
  return (
    <div data-testid="designer-properties" class="nm-props">
      <div class="nm-panel-title">Properties</div>
      <p class="nm-props-empty">Nothing selected.</p>
    </div>
  );
}

function RowPanel({ id }: { id: string }): JSX.Element {
  const row = findRow(id)!;
  const p = row.props ?? {};
  const commit = (patch: Patch): void => mutate('Edit row', () => updateRowProps(id, patch));
  return (
    <div data-testid="designer-properties" class="nm-props">
      <div class="nm-panel-title">Row</div>
      <ColorField label="Background" value={p.bgColor} onCommit={(v) => commit({ bgColor: v })} />
      <PaddingField value={p.padding} onCommit={(v) => commit({ padding: v })} />
      <BorderField value={p.border} onCommit={(v) => commit({ border: v })} />
      <RadiusField value={p.radius} onCommit={(v) => commit({ radius: v })} />
    </div>
  );
}

function CellPanel({ id }: { id: string }): JSX.Element {
  const cell = findCell(id)!;
  const grid = parentGridOfCell(id);
  const p = cell.props ?? {};
  const commit = (patch: Patch): void => mutate('Edit column', () => updateCellProps(id, patch));
  return (
    <div data-testid="designer-properties" class="nm-props">
      <div class="nm-panel-title">Column</div>
      <NumberField label="Width (%)" value={p.width} onCommit={(v) => commit({ width: v })} placeholder="equal" />
      <ColorField label="Background" value={p.bgColor} onCommit={(v) => commit({ bgColor: v })} />
      <PaddingField value={p.padding} onCommit={(v) => commit({ padding: v })} />
      <BorderField value={p.border} onCommit={(v) => commit({ border: v })} />
      <RadiusField value={p.radius} onCommit={(v) => commit({ radius: v })} />
      {grid ? (
        <div class="nm-props-actions">
          <button type="button" class="nm-btn" onClick={() => mutate('Add column', () => addGridCell(grid.id))}>
            + Add column
          </button>
          <button
            type="button"
            class="nm-btn nm-danger"
            disabled={grid.children.length <= 1}
            onClick={() => mutate('Remove column', () => removeGridCell(grid.id, id))}
          >
            Remove column
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Image element editor: source + crop/resize/circle editor + the usual props. */
function ImagePanel({ id }: { id: string }): JSX.Element {
  const el = findElement(id)! as { type: 'image'; props: import('./model.js').ImageProps };
  const commit = (patch: Patch): void => mutate('Edit image', () => updateElementProps(id, patch));
  const [editing, setEditing] = useState(false);

  return (
    <>
      <AssetPicker value={el.props.src} onCommit={(v) => commit({ src: v })} />
      {el.props.src ? (
        <button type="button" data-testid="image-edit-open" class="nm-btn nm-am-open" onClick={() => setEditing(true)}>
          <Crop size={14} /> Crop / resize…
        </button>
      ) : null}
      <TextField label="Alt text" value={el.props.alt ?? ''} onCommit={(v) => commit({ alt: v })} />
      <NumberField label="Width (px)" value={el.props.width} onCommit={(v) => commit({ width: v })} />
      <AlignField value={el.props.align} onCommit={(v) => commit({ align: v })} />
      <TextField label="Link URL" value={el.props.href ?? ''} onCommit={(v) => commit({ href: v || undefined })} />
      <RadiusField value={el.props.radius} onCommit={(v) => commit({ radius: v })} />
      <PaddingField value={el.props.padding} onCommit={(v) => commit({ padding: v })} />
      {editing ? (
        <ImageEditor
          src={el.props.src}
          onApply={(src, width) => {
            commit({ src, width });
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function ElementPanel({ id }: { id: string }): JSX.Element {
  const el = findElement(id)!;
  const commit = (patch: Patch): void => mutate(`Edit ${el.type}`, () => updateElementProps(id, patch));

  return (
    <div data-testid="designer-properties" class="nm-props">
      <div class="nm-panel-title">{el.type}</div>

      {el.type === 'heading' ? (
        <>
          <TextField label="Text" value={el.props.text} onCommit={(v) => commit({ text: v })} testId="prop-heading-text" />
          <SelectField
            label="Level"
            value={el.props.level}
            options={[['h1', 'H1'], ['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'], ['h5', 'H5'], ['h6', 'H6']]}
            onCommit={(v) => commit({ level: v })}
          />
          <ColorField label="Color" value={el.props.color} onCommit={(v) => commit({ color: v })} />
          <AlignField value={el.props.textAlign} onCommit={(v) => commit({ textAlign: v })} />
          <PaddingField value={el.props.padding} onCommit={(v) => commit({ padding: v })} />
        </>
      ) : null}

      {el.type === 'text' ? (
        <>
          <ColorField label="Color" value={el.props.color} onCommit={(v) => commit({ color: v })} />
          <SelectField label="Font size" value={el.props.fontSize ?? ''} options={FONT_SIZE_OPTIONS} onCommit={(v) => commit({ fontSize: v || undefined })} />
          <AlignField value={el.props.textAlign} onCommit={(v) => commit({ textAlign: v })} />
          <NumberField label="Line height" value={el.props.lineHeight} onCommit={(v) => commit({ lineHeight: v })} placeholder="1.5" />
          <PaddingField value={el.props.padding} onCommit={(v) => commit({ padding: v })} />
          <p class="nm-props-hint">Double-click the text on the canvas to edit and format it.</p>
          <p class="nm-props-hint">
            Personalize with <code>{'{{customer.first_name}}'}</code> — shorthand for{' '}
            <code>{'{{customer.attributes.first_name}}'}</code>. Use <code>{'{{customer.email}}'}</code> for built-in
            profile fields.
          </p>
        </>
      ) : null}

      {el.type === 'image' ? <ImagePanel id={id} /> : null}

      {el.type === 'button' ? (
        <>
          <TextField label="Text" value={el.props.text} onCommit={(v) => commit({ text: v })} testId="prop-button-text" />
          <TextField label="URL" value={el.props.url ?? ''} onCommit={(v) => commit({ url: v })} testId="prop-button-url" />
          <ColorField label="Background" value={el.props.bgColor} onCommit={(v) => commit({ bgColor: v })} />
          <ColorField label="Text color" value={el.props.color} onCommit={(v) => commit({ color: v })} />
          <NumberField label="Corner radius (px)" value={el.props.borderRadius} onCommit={(v) => commit({ borderRadius: v })} />
          <SelectField label="Font size" value={el.props.fontSize ?? ''} options={FONT_SIZE_OPTIONS} onCommit={(v) => commit({ fontSize: v || undefined })} />
          <AlignField value={el.props.align} onCommit={(v) => commit({ align: v })} />
          <PaddingField value={el.props.padding} onCommit={(v) => commit({ padding: v })} />
        </>
      ) : null}

      {el.type === 'list' ? <ListPanel id={id} /> : null}

      {el.type === 'separator' ? (
        <>
          <ColorField label="Line color" value={el.props.lineColor} onCommit={(v) => commit({ lineColor: v })} />
          <NumberField label="Thickness (px)" value={el.props.lineThickness} onCommit={(v) => commit({ lineThickness: v })} placeholder="1" />
          <SelectField
            label="Style"
            value={el.props.lineStyle ?? 'solid'}
            options={[['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted']]}
            onCommit={(v) => commit({ lineStyle: v })}
          />
          <NumberField label="Width (%)" value={el.props.lineWidth} onCommit={(v) => commit({ lineWidth: v })} placeholder="100" />
          <PaddingField value={el.props.padding} onCommit={(v) => commit({ padding: v })} />
        </>
      ) : null}

      {el.type === 'grid' ? (
        <>
          <p class="nm-props-hint">Select a column on the canvas to style it. Columns stack automatically on mobile.</p>
          <div class="nm-props-actions">
            <button type="button" class="nm-btn" data-testid="grid-add-column" onClick={() => mutate('Add column', () => addGridCell(id))}>
              + Add column
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** List items editor (add/edit/remove items + list type). */
function ListPanel({ id }: { id: string }): JSX.Element {
  const el = findElement(id)!;
  if (el.type !== 'list') return <></>;
  const p = el.props;
  const commit = (patch: Patch): void => mutate('Edit list', () => updateElementProps(id, patch));
  const [draft, setDraft] = useState('');
  return (
    <>
      <SelectField label="Type" value={p.listType} options={[['ul', 'Bulleted'], ['ol', 'Numbered']]} onCommit={(v) => commit({ listType: v })} />
      <ColorField label="Color" value={p.color} onCommit={(v) => commit({ color: v })} />
      <SelectField label="Font size" value={p.fontSize ?? ''} options={FONT_SIZE_OPTIONS} onCommit={(v) => commit({ fontSize: v || undefined })} />
      <Field label="Items">
        <div class="nm-list-items">
          {p.items.map((item, idx) => (
            <div key={item.id} class="nm-list-item-row">
              <input
                class="nm-prop-input"
                type="text"
                value={item.text}
                onChange={(e) => {
                  const items = p.items.map((it, i) => (i === idx ? { ...it, text: (e.target as HTMLInputElement).value } : it));
                  commit({ items });
                }}
              />
              <button
                type="button"
                class="nm-mini-btn"
                title="Remove item"
                onClick={() => commit({ items: p.items.filter((_, i) => i !== idx) })}
              >
                ✕
              </button>
            </div>
          ))}
          <div class="nm-list-item-row">
            <input
              class="nm-prop-input"
              type="text"
              placeholder="New item…"
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  commit({ items: [...p.items, { id: `li-${Date.now()}`, text: draft.trim() }] });
                  setDraft('');
                }
              }}
            />
            <button
              type="button"
              class="nm-mini-btn"
              title="Add item"
              disabled={!draft.trim()}
              onClick={() => {
                commit({ items: [...p.items, { id: `li-${Date.now()}`, text: draft.trim() }] });
                setDraft('');
              }}
            >
              +
            </button>
          </div>
        </div>
      </Field>
      <PaddingField value={p.padding} onCommit={(v) => commit({ padding: v })} />
    </>
  );
}
