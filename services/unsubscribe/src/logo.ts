// Company logo on the public pages (CLAUDE.md company-settings). Both the
// /unsubscribe and /manage-subscription pages render the sending company's logo
// at the top of the card when one is set. The logo is a SOFT reference
// (companies.logo_asset_id → an uploaded asset, served public-by-uuid at
// `<assetsBase>/assets/<id>`), so we resolve workspace → company → logo here and
// build the public asset URL from the SAME origin the unsubscribe link uses.
//
// The logo is OPTIONAL: with no logo (or no reader/base wired) this yields the
// empty string and the pages render exactly as before.
import type { PreferenceReader } from './preference-handler.js';

/** Escape for an HTML attribute value. */
function escAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Resolve the sending company's logo asset id for a workspace. Scoped in code
 * (the service role bypasses RLS) — joins the workspace to its company and reads
 * `companies.logo_asset_id`. Returns null when there is no logo (or no company).
 * Throws on a falsy workspaceId (the central tenancy guard).
 */
export async function resolveCompanyLogoAssetId(
  reader: PreferenceReader,
  workspaceId: string,
): Promise<string | null> {
  if (!workspaceId) throw new Error('resolveCompanyLogoAssetId: workspaceId is required (tenant-isolation guard)');
  const { rows } = await reader.query<{ logo_asset_id: string | null }>(
    `SELECT c.logo_asset_id
       FROM workspaces w JOIN companies c ON c.id = w.company_id
      WHERE w.id = $1`,
    [workspaceId],
  );
  return rows[0]?.logo_asset_id ?? null;
}

/**
 * Build the `<img>` markup for a logo asset, or '' when there is no asset. The
 * asset URL is `<assetsBaseUrl>/assets/<id>` — the public binary-serve route. A
 * blank assetsBaseUrl (not wired) yields '' (no broken relative image).
 */
export function logoImgTag(assetId: string | null, assetsBaseUrl: string | undefined): string {
  if (!assetId) return '';
  const base = (assetsBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) return '';
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return '';
  const src = `${base}/assets/${assetId}`;
  return `<img src="${escAttr(src)}" alt="" style="max-height:48px;margin:0 auto 16px;display:block" data-testid="page-logo">`;
}

/**
 * The combined resolve + render: returns the logo `<img>` HTML for a workspace
 * (or '' when no logo / no reader / no base). Never throws to the caller — a logo
 * is decorative; a lookup failure must not break the unsubscribe/manage page.
 */
export async function renderCompanyLogo(
  reader: PreferenceReader | undefined,
  assetsBaseUrl: string | undefined,
  workspaceId: string,
): Promise<string> {
  if (!reader || !assetsBaseUrl) return '';
  try {
    const assetId = await resolveCompanyLogoAssetId(reader, workspaceId);
    return logoImgTag(assetId, assetsBaseUrl);
  } catch {
    return '';
  }
}
