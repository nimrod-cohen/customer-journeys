// Shared list pagination + search parsing (§12/§13). Numbered-page pagination: a list
// endpoint accepts ?limit=&page=&q=. Paging is OPT-IN — when `limit` is ABSENT the
// endpoint returns the WHOLE result (back-compat for the many places that read a list as a
// dropdown source, e.g. GET /segments). When `limit` is present the endpoint returns one
// page (LIMIT/OFFSET) plus a total count so the UI can render "1–50 of N" + page numbers.
//
// `q` is a free-text search term applied SERVER-SIDE (ILIKE) by each handler over its own
// searchable columns, so search spans the whole table — not just the loaded page.

/** Parsed paging/search inputs for a list endpoint. */
export interface PageParams {
  /** Rows per page, or null = no limit (return all — paging not requested). 1..MAX. */
  readonly limit: number | null;
  /** 1-based page number (≥ 1). Only meaningful when `limit` is set. */
  readonly page: number;
  /** Row offset = (page-1)*limit, or 0 when unpaged. */
  readonly offset: number;
  /** Trimmed free-text search term ('' when none). */
  readonly q: string;
}

/** Hard ceiling on page size (defends against a client asking for a huge page). */
export const MAX_PAGE_SIZE = 100;

/**
 * Parse `?limit&page&q` from a query map.
 *   - `limit` absent ⇒ `defaultLimit` (default null = UNPAGED, return all). A present
 *     `limit` is floored and clamped to 1..MAX_PAGE_SIZE.
 *   - `page` is floored and clamped to ≥ 1 (default 1).
 *   - `offset` = (page-1)*limit (0 when unpaged).
 *   - `q` is trimmed.
 */
export function parsePageParams(
  query: Readonly<Record<string, string>>,
  defaultLimit: number | null = null,
): PageParams {
  let limit: number | null = defaultLimit;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Math.floor(Number(query.limit));
    limit = Number.isFinite(n) && n > 0 ? Math.min(MAX_PAGE_SIZE, n) : (defaultLimit ?? 50);
  }
  const pageN = Math.floor(Number(query.page));
  const page = Number.isFinite(pageN) && pageN > 0 ? pageN : 1;
  const offset = limit ? (page - 1) * limit : 0;
  const q = (query.q ?? '').trim();
  return { limit, page, offset, q };
}

/**
 * SQL `LIMIT $a OFFSET $b` clause for a paged query, binding the next two params after
 * `nextParamIndex` (1-based index of the NEXT free $n). Returns the clause text + the two
 * values to append. Empty (no clause, no values) when unpaged (`limit === null`).
 */
export function pageClause(
  p: PageParams,
  nextParamIndex: number,
): { text: string; values: number[] } {
  if (p.limit === null) return { text: '', values: [] };
  return { text: ` LIMIT $${nextParamIndex} OFFSET $${nextParamIndex + 1}`, values: [p.limit, p.offset] };
}

/** The `{ total, page, page_size }` envelope a paged list response carries alongside its
 *  rows. When unpaged, `page_size` is null and `page` is 1. */
export function pageMeta(p: PageParams, total: number): { total: number; page: number; page_size: number | null } {
  return { total, page: p.limit ? p.page : 1, page_size: p.limit };
}
