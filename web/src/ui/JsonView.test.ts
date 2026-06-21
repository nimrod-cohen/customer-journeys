import { describe, it, expect } from 'vitest';
import { prettyJson, parseJsonObjectOrArray } from './JsonView.js';

describe('prettyJson', () => {
  it('indents an object', () => {
    expect(prettyJson({ a: 1, b: 'x' })).toBe('{\n  "a": 1,\n  "b": "x"\n}');
  });

  it('parses + indents a JSON STRING (the activity-log / event payload case)', () => {
    expect(prettyJson('{"name":"Ada","n":2}')).toBe('{\n  "name": "Ada",\n  "n": 2\n}');
    expect(prettyJson('[1,2]')).toBe('[\n  1,\n  2\n]');
  });

  it('returns a plain (non-JSON) string verbatim', () => {
    expect(prettyJson('unsubscribed via one-click')).toBe('unsubscribed via one-click');
    expect(prettyJson('42')).toBe('42'); // a bare scalar string is not an object/array
  });
});

describe('parseJsonObjectOrArray', () => {
  it('returns the value for an object/array string, undefined otherwise', () => {
    expect(parseJsonObjectOrArray('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObjectOrArray('[1]')).toEqual([1]);
    expect(parseJsonObjectOrArray('hello')).toBeUndefined();
    expect(parseJsonObjectOrArray('{bad json')).toBeUndefined();
    expect(parseJsonObjectOrArray('"a string"')).toBeUndefined();
  });
});
