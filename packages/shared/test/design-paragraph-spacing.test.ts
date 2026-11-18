// The email's paragraph spacing (Template settings): the gap under every paragraph,
// written onto each <p> at compile time so it holds in Gmail/Outlook.
import { describe, it, expect } from 'vitest';
import { designToMjml, type EmailDesign } from '../src/email-design/index.js';

const design = (settings: Record<string, unknown>): EmailDesign =>
  ({
    version: 1,
    settings,
    rows: [{ id: 'r1', elements: [{ id: 'e1', type: 'text', props: { html: '<p>a</p><p>b</p>' } }] }],
  }) as unknown as EmailDesign;

describe('template paragraph spacing', () => {
  it('emits an inlined paragraph margin', () => {
    expect(designToMjml(design({ paragraphSpacing: 8 }))).toContain('<mj-style inline="inline">p{margin:0 0 8px;}</mj-style>');
  });
  it('0 is a real value (no gap)', () => {
    expect(designToMjml(design({ paragraphSpacing: 0 }))).toContain('p{margin:0 0 0px;}');
  });
  it('unset → nothing emitted (clients keep their default)', () => {
    expect(designToMjml(design({}))).not.toContain('inline="inline"');
  });
});
