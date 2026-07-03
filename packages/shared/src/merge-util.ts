// Shared internals for the {{token}} merge-map builders (customer.* / event.* /
// journey.*). Extracted so the three namespaces stringify + flatten IDENTICALLY.

/** Stringify a scalar merge value: a Date → ISO 8601, anything else via String(). */
export function stringifyMergeValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Recursively flatten an object/array into dotted merge tokens under `prefix`,
 * emitting only SCALAR leaves (a whole object/array is never a single tag). Array
 * indices become path segments (e.g. `items.0.sku`). Null/undefined are skipped.
 * Mutates + returns `out`.
 */
export function flattenToMergeMap(
  node: Record<string, unknown> | unknown[],
  prefix: string,
  out: Record<string, string>,
): Record<string, string> {
  const entries: [string, unknown][] = Array.isArray(node)
    ? node.map((v, i) => [String(i), v])
    : Object.entries(node);
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    const token = `${prefix}${k}`;
    if (typeof v === 'object') {
      flattenToMergeMap(v as Record<string, unknown> | unknown[], `${token}.`, out);
    } else {
      out[token] = stringifyMergeValue(v);
    }
  }
  return out;
}
