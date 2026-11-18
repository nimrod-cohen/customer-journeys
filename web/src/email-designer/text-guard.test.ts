// @vitest-environment happy-dom
// Guard against silently losing a text block: when a block that had words is saved
// EMPTY, the designer says so and offers to put the text back.
import { describe, it, expect } from 'vitest';
import { textWasCleared } from './text-guard.js';

describe('textWasCleared', () => {
  it('is true when a block with words is saved with none', () => {
    expect(textWasCleared('<p>שלום <b>עולם</b></p>', '')).toBe(true);
    expect(textWasCleared('<span><p>hi</p></span>', '<p><br></p>')).toBe(true);
    expect(textWasCleared('<p>hi</p>', '<p>&nbsp; </p>')).toBe(true);
  });

  it('is false for an ordinary edit, an already-empty block, or one left with only an image', () => {
    expect(textWasCleared('<p>hi</p>', '<p>hello</p>')).toBe(false);
    expect(textWasCleared('', '')).toBe(false);
    expect(textWasCleared('<p><br></p>', '')).toBe(false);
    expect(textWasCleared('<p>hi <img src="/a.png"></p>', '<p><img src="/a.png"></p>')).toBe(false);
  });

  it('counts a merge tag as content', () => {
    expect(textWasCleared('<p>{{customer.first_name}}</p>', '')).toBe(true);
  });
});
