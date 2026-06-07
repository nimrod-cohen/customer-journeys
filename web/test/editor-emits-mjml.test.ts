import { describe, it, expect } from 'vitest';
import {
  serializeEditorToMjml,
  buildSaveTemplatePayload,
  type EditorState,
} from '../src/serialize.js';
import { compileMjml } from '@cdp/email';

// §11 / CLAUDE.md non-negotiable: the editor EMITS MJML, never hand-rolled email
// HTML. Asserted here at the UNIT tier: the serialized output is rooted at
// <mjml>, uses mj-* elements, references images as <mj-image src>, and — the
// strongest proof — the SAME server-side compileMjml accepts it and turns it into
// real HTML. The save payload carries {name, mjml} only.

const state: EditorState = {
  blocks: [
    { type: 'text', content: 'Hello world' },
    { type: 'image', src: 'https://images.cdp.example/ws/abc-logo.png', alt: 'Logo' },
    { type: 'button', content: 'Shop now', href: 'https://shop.example' },
  ],
};

describe('serializeEditorToMjml', () => {
  it('roots the document at <mjml> (never raw HTML)', () => {
    const mjml = serializeEditorToMjml(state);
    expect(mjml.startsWith('<mjml>')).toBe(true);
    expect(mjml).toContain('<mj-body>');
    // No hand-rolled email HTML wrappers.
    expect(mjml).not.toMatch(/<html|<table|<!DOCTYPE/i);
  });

  it('references images as <mj-image src> pointing at the uploaded asset URL', () => {
    const mjml = serializeEditorToMjml(state);
    expect(mjml).toContain('<mj-image src="https://images.cdp.example/ws/abc-logo.png"');
  });

  it('emits MJML the SERVER compiler (compileMjml) accepts and turns into HTML', () => {
    const mjml = serializeEditorToMjml(state);
    const html = compileMjml(mjml);
    expect(html).toMatch(/<html/i);
    expect(html.toLowerCase()).toContain('hello world');
    expect(html).toContain('https://images.cdp.example/ws/abc-logo.png');
  });

  it('escapes user text so it cannot break out of the MJML', () => {
    const mjml = serializeEditorToMjml({ blocks: [{ type: 'text', content: '<script>x</script>' }] });
    expect(mjml).not.toContain('<script>');
    expect(mjml).toContain('&lt;script&gt;');
    // Still compiles.
    expect(() => compileMjml(mjml)).not.toThrow();
  });
});

describe('buildSaveTemplatePayload', () => {
  it('returns ONLY { name, mjml } (no HTML, no workspace id)', () => {
    const payload = buildSaveTemplatePayload(state, 'Welcome');
    expect(Object.keys(payload).sort()).toEqual(['mjml', 'name']);
    expect(payload.name).toBe('Welcome');
    expect(payload.mjml.startsWith('<mjml>')).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/compiled|<html/i);
  });
});
