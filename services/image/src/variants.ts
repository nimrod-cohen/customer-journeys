// Variant planner (§11). Given an uploaded image's key + source dimensions,
// decide the responsive variants to generate with `sharp`. Pure + deterministic
// (no sharp, no I/O here — the orchestrator runs sharp per spec). Rules:
//   - every variant key stays under the SAME workspace prefix as the original;
//   - NEVER upscale — a target width wider than the source is dropped;
//   - keys are distinct (suffixed by target width) and keep the original ext.
import { parseWorkspaceFromKey } from './key.js';

/** Standard responsive target widths (px), descending. */
export const VARIANT_WIDTHS = [1200, 800, 400] as const;

/** Source image pixel dimensions. */
export interface SourceDimensions {
  readonly width: number;
  readonly height: number;
}

/** A single variant to produce: target key + width (height kept proportional). */
export interface VariantSpec {
  readonly key: string;
  readonly width: number;
}

/** Split a key into `{ prefix-without-ext, ext }` preserving the workspace path. */
function splitKey(key: string): { stem: string; ext: string } {
  const dot = key.lastIndexOf('.');
  const slash = key.lastIndexOf('/');
  if (dot > slash && dot >= 0) {
    return { stem: key.slice(0, dot), ext: key.slice(dot + 1) };
  }
  return { stem: key, ext: '' };
}

/**
 * Plan the variant specs for an uploaded image. Only widths strictly less than
 * (or equal to) the source width are emitted — no upscaling. Each variant key is
 * `<stem>-w<width>.<ext>`, under the original's workspace prefix.
 */
export function planVariants(originalKey: string, source: SourceDimensions): VariantSpec[] {
  // Validate the key is workspace-prefixed (throws if not) — variants must never
  // be written outside a workspace.
  parseWorkspaceFromKey(originalKey);
  const { stem, ext } = splitKey(originalKey);
  const suffix = ext ? `.${ext}` : '';
  return VARIANT_WIDTHS.filter((w) => w <= source.width).map((w) => ({
    key: `${stem}-w${w}${suffix}`,
    width: w,
  }));
}
