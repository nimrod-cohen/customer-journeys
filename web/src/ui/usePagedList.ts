// usePagedList — shared state for a server-paged, server-searched list (numbered pages).
// The owner supplies a `fetcher(params)` that calls its endpoint with {limit, page, q} and
// returns {rows, total}. The hook owns q (debounced), page (reset to 1 when q or any `dep`
// changes), total, rows, and a loading flag. Keeps the four list screens consistent.
import { useEffect, useRef, useState } from 'preact/hooks';

export const DEFAULT_PAGE_SIZE = 50;

export interface PagedResult<T> {
  rows: T[];
  total: number;
}

export interface PagedList<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  loading: boolean;
  /** False until the FIRST fetch settles (for an initial "Loading…" gate). */
  loaded: boolean;
  /** Set the search term (debounced) — also resets to page 1. */
  setQ: (q: string) => void;
  /** Jump to a page (the Pagination control calls this). */
  setPage: (page: number) => void;
  /** Force a re-fetch of the current page (after a mutation: delete, duplicate, …). */
  reload: () => void;
}

export function usePagedList<T>(
  fetcher: (params: { limit: number; page: number; q: string }) => Promise<PagedResult<T>>,
  opts: { pageSize?: number; deps?: readonly unknown[] } = {},
): PagedList<T> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const deps = opts.deps ?? [];
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQinner] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0); // bump to force a reload
  // Keep the latest fetcher without making it a fetch dependency (avoids refetch loops
  // when the parent passes a fresh closure each render).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const setQ = (next: string): void => {
    setQinner(next);
    setPage(1); // a new search always starts at the first page
  };

  // Reset to page 1 whenever an external dependency (e.g. workspace, segment filter) changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), deps);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void fetcherRef
        .current({ limit: pageSize, page, q: q.trim() })
        .then((r) => {
          if (cancelled) return;
          setRows(r.rows);
          setTotal(r.total);
        })
        .catch(() => {
          if (cancelled) return;
          setRows([]);
          setTotal(0);
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
            setLoaded(true);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, q, tick, pageSize, ...deps]);

  return { rows, total, page, pageSize, q, loading, loaded, setQ, setPage, reload: () => setTick((n) => n + 1) };
}
