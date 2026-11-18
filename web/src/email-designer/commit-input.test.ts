// @vitest-environment happy-dom
// The app loads preact/compat, which turns an input's onChange into a per-KEYSTROKE
// event. A field that parsed + rewrote itself on every keystroke turned "1.4" into
// "1" → "1" (dot erased) → "14" → clamped 3. CommitInput lets you type freely and
// applies the value only when you leave the field or press Enter.
import 'preact/compat';
import { describe, it, expect, afterEach } from 'vitest';
import { render, h } from 'preact';
import { CommitInput } from './CommitInput.js';
import { parseLineHeight } from './decimal.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const host = document.createElement('div');
document.body.appendChild(host);
afterEach(() => render(null, host));

/** Type like a person: one key at a time, letting the UI re-render in between. */
async function type(input: HTMLInputElement, text: string): Promise<void> {
  for (const ch of text) {
    input.value += ch;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
  }
}

describe('CommitInput', () => {
  it('keeps "1.4" while typing and commits 1.4 on leaving the field', async () => {
    const commits: (number | undefined)[] = [];
    render(h(CommitInput, { value: undefined, parse: parseLineHeight, onCommit: (v: number | undefined) => commits.push(v) }), host);
    const input = host.querySelector('input')!;
    input.focus();
    await type(input, '1.4');
    expect(input.value).toBe('1.4');
    expect(commits).toEqual([]);
    input.blur(); // a real blur (preact/compat listens for focusout)
    await tick();
    expect(commits).toEqual([1.4]);
    expect(input.value).toBe('1.4');
  });

  it('Enter commits too; "1,4" becomes 1.4; blank commits undefined', async () => {
    const commits: (number | undefined)[] = [];
    render(h(CommitInput, { value: 2, parse: parseLineHeight, onCommit: (v: number | undefined) => commits.push(v) }), host);
    const input = host.querySelector('input')!;
    input.value = '';
    await type(input, '1,4');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(commits).toEqual([1.4]);
    expect(input.value).toBe('1.4');
    input.value = '';
    input.blur();
    await tick();
    expect(commits).toEqual([1.4, undefined]);
  });
});
