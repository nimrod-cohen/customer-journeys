import { describe, it, expect } from 'vitest';
import {
  cloneRowsWithFreshIds,
  componentIdsIn,
  designToMjml,
  expandComponents,
  refreshComponents,
  type DesignRow,
  type EmailDesign,
} from '../src/email-design/index.js';

const textRow = (id: string, html: string): DesignRow => ({ id, elements: [{ id: `${id}-t`, type: 'text', props: { html } }] });
const linked = (id: string, compId: string, rows: DesignRow[], name = 'Footer'): DesignRow => ({
  id,
  elements: [],
  component: { id: compId, name, rows },
});

describe('saved email components', () => {
  it('a linked row sends the component rows in its place', () => {
    const d: EmailDesign = { version: 1, rows: [textRow('r1', 'Hello'), linked('r2', 'c1', [textRow('f1', 'Unsubscribe {{unsubscribe}}')])] };
    expect(expandComponents(d.rows).map((r) => r.id)).toEqual(['r1', 'f1']);
    const mjml = designToMjml(d);
    expect(mjml).toContain('Hello');
    expect(mjml).toContain('Unsubscribe {{unsubscribe}}');
  });

  it('lists the linked component ids once each', () => {
    const d: EmailDesign = { version: 1, rows: [linked('a', 'c1', []), textRow('b', 'x'), linked('c', 'c1', []), linked('d', 'c2', [])] };
    expect(componentIdsIn(d)).toEqual(['c1', 'c2']);
  });

  it('refresh swaps in the current content and keeps a deleted component as it was', () => {
    const d: EmailDesign = { version: 1, rows: [linked('a', 'c1', [textRow('old', 'old footer')]), linked('b', 'gone', [textRow('k', 'kept')])] };
    const out = refreshComponents(d, new Map([['c1', { name: 'New name', rows: [textRow('new', 'new footer')] }]]));
    expect(out.rows[0]!.component).toEqual({ id: 'c1', name: 'New name', rows: [textRow('new', 'new footer')] });
    expect(out.rows[1]).toBe(d.rows[1]);
  });

  it('components never nest: a link inside a component is flattened', () => {
    const inner = linked('i', 'c9', [textRow('deep', 'deep')]);
    const out = refreshComponents({ version: 1, rows: [linked('a', 'c1', [])] }, new Map([['c1', { name: 'F', rows: [inner] }]]));
    expect(out.rows[0]!.component!.rows.some((r) => r.component)).toBe(false);
  });

  it('unlinking copies with fresh, unique ids', () => {
    let n = 0;
    const grid: DesignRow = {
      id: 'g',
      elements: [{ id: 'gr', type: 'grid', props: { columns: 1 }, children: [{ id: 'cell', elements: [{ id: 'leaf', type: 'text', props: { html: 'x' } }] }] }],
    };
    const copy = cloneRowsWithFreshIds([textRow('r', 'a'), grid], (p) => `${p}-${++n}`);
    const ids = JSON.stringify(copy).match(/"id":"[^"]+"/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(copy)).not.toContain('"id":"leaf"');
  });
});
