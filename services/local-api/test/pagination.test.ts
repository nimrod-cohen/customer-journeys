import { describe, it, expect } from 'vitest';
import { parsePageParams, pageClause, pageMeta, MAX_PAGE_SIZE } from '../src/pagination.js';

describe('parsePageParams', () => {
  it('no limit param ⇒ UNPAGED (return all) by default', () => {
    expect(parsePageParams({})).toEqual({ limit: null, page: 1, offset: 0, q: '' });
  });
  it('a default limit applies when no param is given', () => {
    expect(parsePageParams({}, 50)).toEqual({ limit: 50, page: 1, offset: 0, q: '' });
  });
  it('parses limit + page → offset', () => {
    expect(parsePageParams({ limit: '20', page: '3' })).toMatchObject({ limit: 20, page: 3, offset: 40 });
  });
  it('clamps limit to MAX_PAGE_SIZE and to ≥ 1', () => {
    expect(parsePageParams({ limit: '9999' }).limit).toBe(MAX_PAGE_SIZE);
    expect(parsePageParams({ limit: '0' }, 50).limit).toBe(50); // invalid → falls back to default
    expect(parsePageParams({ limit: '-5' }, 50).limit).toBe(50);
  });
  it('clamps page to ≥ 1 and trims q', () => {
    expect(parsePageParams({ limit: '10', page: '0' }).page).toBe(1);
    expect(parsePageParams({ limit: '10', page: 'abc' }).page).toBe(1);
    expect(parsePageParams({ q: '  spring  ' }).q).toBe('spring');
  });
});

describe('pageClause', () => {
  it('emits LIMIT/OFFSET binding the next two params', () => {
    const c = pageClause(parsePageParams({ limit: '25', page: '2' }), 3);
    expect(c.text).toBe(' LIMIT $3 OFFSET $4');
    expect(c.values).toEqual([25, 25]);
  });
  it('is empty when unpaged', () => {
    expect(pageClause(parsePageParams({}), 2)).toEqual({ text: '', values: [] });
  });
});

describe('pageMeta', () => {
  it('reports total/page/page_size when paged', () => {
    expect(pageMeta(parsePageParams({ limit: '50', page: '4' }), 1000)).toEqual({ total: 1000, page: 4, page_size: 50 });
  });
  it('page_size null + page 1 when unpaged', () => {
    expect(pageMeta(parsePageParams({}), 7)).toEqual({ total: 7, page: 1, page_size: null });
  });
});
