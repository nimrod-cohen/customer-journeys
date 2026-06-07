// S3 key construction + scoping (§11, CLAUDE.md invariants 1 & 2).
//
// EVERY image object lives under `${workspace_id}/`. The workspace prefix is the
// tenancy boundary in object storage: a presigned URL minted for workspace A can
// only PUT under `A/`, and the service-role variant Lambda (which BYPASSES RLS)
// re-derives the workspace from the key prefix and refuses anything outside the
// scope it was handed. All filename handling is defensive: a hostile filename
// (`../`, separators, absolute paths, NUL bytes) is sanitized so it can never
// escape the prefix. No I/O — pure, unit-tested without AWS.
import { randomUUID } from 'node:crypto';

/** Thrown when a key is not under the expected workspace prefix (§11 guard). */
export class KeyScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyScopeError';
  }
}

/**
 * Reduce a user-supplied filename to a single safe path segment: strip any
 * directory components and traversal, keep only `[a-z0-9._-]`, lowercase, and
 * collapse the rest. Returns a normalized `{ base, ext }`; both are guaranteed
 * free of separators and `..`.
 */
function sanitizeFilename(filename: string): { base: string; ext: string } {
  // Take only the final path component (handles both `/` and `\`).
  const lastSep = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const tail = lastSep >= 0 ? filename.slice(lastSep + 1) : filename;

  const dot = tail.lastIndexOf('.');
  const rawExt = dot > 0 ? tail.slice(dot + 1) : '';
  const rawBase = dot > 0 ? tail.slice(0, dot) : tail;

  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const base = clean(rawBase) || 'image';
  const ext = clean(rawExt);
  return { base, ext };
}

/**
 * Build a collision-resistant S3 key for an uploaded image, always under the
 * `${workspaceId}/` prefix. A random UUID makes repeated uploads of the same
 * filename distinct. The filename is sanitized so no traversal/separator can
 * escape the prefix.
 */
export function buildImageKey(workspaceId: string, filename: string): string {
  if (!workspaceId) {
    throw new Error('buildImageKey: workspaceId is required (tenant-isolation guard)');
  }
  const { base, ext } = sanitizeFilename(filename ?? '');
  const id = randomUUID();
  const name = ext ? `${id}-${base}.${ext}` : `${id}-${base}`;
  return `${workspaceId}/${name}`;
}

/**
 * Extract the workspace id from an image key's leading prefix. Throws if the key
 * has no prefix (a bare filename) — such a key is never one we minted.
 */
export function parseWorkspaceFromKey(key: string): string {
  const slash = key.indexOf('/');
  if (slash <= 0) {
    throw new KeyScopeError(`parseWorkspaceFromKey: key has no workspace prefix: ${key}`);
  }
  return key.slice(0, slash);
}

/**
 * Assert a key belongs to `workspaceId` (its prefix matches). Returns the key on
 * success so it can be used inline; throws `KeyScopeError` on any mismatch — the
 * guard the service-role variant Lambda relies on (it bypasses RLS).
 */
export function assertKeyInWorkspace(workspaceId: string, key: string): string {
  if (!workspaceId) {
    throw new Error('assertKeyInWorkspace: workspaceId is required (tenant-isolation guard)');
  }
  let owner: string;
  try {
    owner = parseWorkspaceFromKey(key);
  } catch {
    throw new KeyScopeError(`assertKeyInWorkspace: key has no workspace prefix: ${key}`);
  }
  if (owner !== workspaceId) {
    throw new KeyScopeError(
      `assertKeyInWorkspace: key for workspace ${owner} is not in workspace ${workspaceId}`,
    );
  }
  return key;
}
