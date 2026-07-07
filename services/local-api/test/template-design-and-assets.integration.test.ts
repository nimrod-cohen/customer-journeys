// Phase 2 of the email-designer port (§11): templates carry the designer's
// editable `design` JSON alongside the derived MJML; library templates CLONE into
// independently-mutable working copies (for broadcasts/campaigns); assets upload
// workspace-scoped and serve public-by-uuid as binary. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { createApp } from '../src/index.js';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e13-0000-4000-8000-000000000a01';
const OTHER = '0c0d0e13-0000-4000-8000-000000000a02';
const USER = '0c0d0e13-0000-4000-8000-0000000000b1';
// Distinct COMPANIES so USER (owner of WS's company) can't reach OTHER (a different
// company) — company-centric RBAC: an owner sees every workspace in THEIR company.
const COW = '0c0d0e13-0000-4000-8000-0000000000f1';
const COO = '0c0d0e13-0000-4000-8000-0000000000f2';

const MJML = '<mjml><mj-body><mj-section><mj-column><mj-text>hi</mj-text></mj-column></mj-section></mj-body></mjml>';
const DESIGN = {
  version: 1,
  settings: { direction: 'rtl', bodyWidth: 640 },
  rows: [{ id: 'row-1', elements: [{ id: 'e1', type: 'text', props: { html: 'hi' } }] }],
};
// A 1×1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('template design + clone + assets (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'CoW'),($2,'CoO')", [COW, COO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, COW]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [OTHER, COO]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM assets WHERE workspace_id = ANY($1)', [[WS, OTHER]]);
    await world.pool.query('DELETE FROM asset_folders WHERE workspace_id = ANY($1)', [[WS, OTHER]]);
    await world.pool.query('DELETE FROM email_templates WHERE workspace_id = ANY($1)', [[WS, OTHER]]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    for (const ws of [WS, OTHER]) await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    await world.pool.query('DELETE FROM companies WHERE id = ANY($1)', [[COW, COO]]);
  }

  it('design round-trips: create with design → get → update design', async () => {
    const c = await call(world.env, 'POST', '/templates', {
      token: tok(),
      body: { name: 'Designed', mjml: MJML, design: DESIGN },
    });
    expect(c.status).toBe(201);
    const id = (c.body as { template: { id: string } }).template.id;

    const g = await call(world.env, 'GET', `/templates/${id}`, { token: tok() });
    const t = (g.body as { template: { design: typeof DESIGN; kind: string } }).template;
    expect(t.design).toEqual(DESIGN);
    expect(t.kind).toBe('library');

    const newDesign = { ...DESIGN, rows: [] };
    await call(world.env, 'PUT', `/templates/${id}`, { token: tok(), body: { design: newDesign } });
    const g2 = await call(world.env, 'GET', `/templates/${id}`, { token: tok() });
    expect((g2.body as { template: { design: { rows: unknown[] } } }).template.design.rows).toEqual([]);
  });

  it('clone → independent working copy; library list excludes copies', async () => {
    const c = await call(world.env, 'POST', '/templates', {
      token: tok(),
      body: { name: 'Library T', mjml: MJML, design: DESIGN },
    });
    const libId = (c.body as { template: { id: string } }).template.id;

    const cl = await call(world.env, 'POST', `/templates/${libId}/clone`, { token: tok(), body: {} });
    expect(cl.status).toBe(201);
    const copyId = (cl.body as { template: { id: string } }).template.id;
    expect(copyId).not.toBe(libId);

    // The copy carries the design + provenance and is kind='copy'.
    const gc = await call(world.env, 'GET', `/templates/${copyId}`, { token: tok() });
    const copy = (gc.body as { template: { kind: string; source_template_id: string; design: unknown } }).template;
    expect(copy.kind).toBe('copy');
    expect(copy.source_template_id).toBe(libId);
    expect(copy.design).toEqual(DESIGN);

    // Mutating the copy does NOT touch the library original.
    await call(world.env, 'PUT', `/templates/${copyId}`, {
      token: tok(),
      body: { name: 'Copy edited', mjml: MJML.replace('hi', 'changed'), design: { ...DESIGN, rows: [] } },
    });
    const gl = await call(world.env, 'GET', `/templates/${libId}`, { token: tok() });
    const lib = (gl.body as { template: { name: string; mjml: string } }).template;
    expect(lib.name).toBe('Library T');
    expect(lib.mjml).toContain('hi');

    // The Templates list shows library entries only — never working copies.
    const list = await call(world.env, 'GET', '/templates', { token: tok() });
    const ids = (list.body as { templates: Array<{ id: string }> }).templates.map((t) => t.id);
    expect(ids).toContain(libId);
    expect(ids).not.toContain(copyId);
  });

  it('delete a library template detaches its copies; copies survive; cross-ws blocked', async () => {
    const c = await call(world.env, 'POST', '/templates', {
      token: tok(),
      body: { name: 'Deletable', mjml: MJML, design: DESIGN },
    });
    const libId = (c.body as { template: { id: string } }).template.id;
    // Clone it (a broadcast's working copy points home via source_template_id).
    const cl = await call(world.env, 'POST', `/templates/${libId}/clone`, { token: tok(), body: {} });
    const copyId = (cl.body as { template: { id: string } }).template.id;

    // A foreign user cannot delete it (workspace-scoped → not found / forbidden).
    const foreign = tokenFor(USER, OTHER);
    expect([403, 404]).toContain(
      (await call(world.env, 'DELETE', `/templates/${libId}`, { token: foreign })).status,
    );

    // Owner deletes the library template (the self-FK from the copy is detached).
    const del = await call(world.env, 'DELETE', `/templates/${libId}`, { token: tok() });
    expect(del.status).toBe(200);

    // It's gone from the library, but the broadcast's COPY still exists.
    expect((await call(world.env, 'GET', `/templates/${libId}`, { token: tok() })).status).toBe(404);
    const gc = await call(world.env, 'GET', `/templates/${copyId}`, { token: tok() });
    expect(gc.status).toBe(200);
    expect((gc.body as { template: { source_template_id: string | null } }).template.source_template_id).toBeNull();

    // Deleting again is a clean 404.
    expect((await call(world.env, 'DELETE', `/templates/${libId}`, { token: tok() })).status).toBe(404);
  });

  it('a working COPY is not user-deletable via DELETE /templates (library only)', async () => {
    const c = await call(world.env, 'POST', '/templates', { token: tok(), body: { name: 'Lib2', mjml: MJML } });
    const libId = (c.body as { template: { id: string } }).template.id;
    const cl = await call(world.env, 'POST', `/templates/${libId}/clone`, { token: tok(), body: {} });
    const copyId = (cl.body as { template: { id: string } }).template.id;

    // The DELETE only targets kind='library' → a copy id is a no-op 404…
    expect((await call(world.env, 'DELETE', `/templates/${copyId}`, { token: tok() })).status).toBe(404);
    // …and the copy is still there.
    expect((await call(world.env, 'GET', `/templates/${copyId}`, { token: tok() })).status).toBe(200);
  });

  it('cloning a cross-workspace template id is 404', async () => {
    const c = await call(world.env, 'POST', '/templates', {
      token: tok(),
      body: { name: 'Mine', mjml: MJML },
    });
    const id = (c.body as { template: { id: string } }).template.id;
    const foreign = tokenFor(USER, OTHER); // no membership in OTHER
    expect([403, 404]).toContain(
      (await call(world.env, 'POST', `/templates/${id}/clone`, { token: foreign, body: {} })).status,
    );
  });

  it('asset upload → public binary serve (CloudFront model)', async () => {
    const up = await call(world.env, 'POST', '/assets', {
      token: tok(),
      body: { filename: 'pixel.png', mime: 'image/png', data_base64: PNG_B64 },
    });
    expect(up.status).toBe(201);
    const { id, path } = up.body as { id: string; path: string };
    expect(path).toBe(`/assets/${id}`);

    // Serving goes through the Hono app (binary, no auth) — like a CDN URL.
    const app = createApp({ pool: world.pool });
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(20);
    expect(Buffer.from(buf).toString('base64')).toBe(PNG_B64);

    // Unknown / malformed ids 404.
    expect((await app.request('/assets/0c0d0e13-dead-4000-8000-00000000beef')).status).toBe(404);
    expect((await app.request('/assets/not-a-uuid')).status).toBe(404);
  });

  it('uploads land in the GALLERY with folders; the list is workspace-scoped', async () => {
    // Two uploads into folders (one nested, messy input gets normalized) + root.
    const up = (filename: string, folder: string) =>
      call(world.env, 'POST', '/assets', {
        token: tok(),
        body: { filename, mime: 'image/png', data_base64: PNG_B64, folder },
      });
    const a = await up('logo.png', 'logos');
    expect((a.body as { folder: string }).folder).toBe('logos');
    const b = await up('hero.png', ' products // 2026 ');
    expect((b.body as { folder: string }).folder).toBe('products/2026');
    await up('root.png', '');

    const list = await call(world.env, 'GET', '/assets', { token: tok() });
    expect(list.status).toBe(200);
    const assets = (list.body as { assets: Array<{ filename: string; folder: string; path: string }> }).assets;
    const byName = Object.fromEntries(assets.map((x) => [x.filename, x]));
    expect(byName['logo.png']!.folder).toBe('logos');
    expect(byName['hero.png']!.folder).toBe('products/2026');
    expect(byName['root.png']!.folder).toBe('');
    expect(byName['logo.png']!.path).toMatch(/^\/assets\//);

    // Another workspace's gallery doesn't include them (no membership → 403/404,
    // and a member of OTHER would get an empty list — scoping is by token).
    const foreign = await call(world.env, 'GET', '/assets', { token: tokenFor(USER, OTHER) });
    expect([403, 404]).toContain(foreign.status);
  });

  it('asset folders persist even while empty and merge with implicit ones', async () => {
    const c = await call(world.env, 'POST', '/asset-folders', { token: tok(), body: { name: ' Banners / 2026 ' } });
    expect(c.status).toBe(201);
    expect((c.body as { name: string }).name).toBe('Banners/2026');

    const list = await call(world.env, 'GET', '/assets', { token: tok() });
    const { folders, assets } = list.body as { folders: string[]; assets: Array<{ size_bytes: number }> };
    expect(folders).toContain('Banners/2026'); // persisted, still empty
    expect(folders).toContain('logos'); // implicit from an earlier upload
    // size metadata is present and sane (the 1×1 png is ~70 bytes).
    expect(assets.every((a) => a.size_bytes > 0 && a.size_bytes < 10_000)).toBe(true);
  });

  it('management: rename/move/delete assets; rename/delete folders cascade', async () => {
    const up = async (filename: string, folder: string) => {
      const r = await call(world.env, 'POST', '/assets', {
        token: tok(),
        body: { filename, mime: 'image/png', data_base64: PNG_B64, folder },
      });
      return (r.body as { id: string }).id;
    };
    const a1 = await up('one.png', 'mgmt');
    const a2 = await up('two.png', 'mgmt/deep');

    // Rename + move an asset.
    await call(world.env, 'PATCH', `/assets/${a1}`, { token: tok(), body: { filename: 'renamed.png', folder: 'elsewhere' } });
    let list = (await call(world.env, 'GET', '/assets', { token: tok() })).body as {
      assets: Array<{ id: string; filename: string; folder: string }>;
      folders: string[];
    };
    const moved = list.assets.find((x) => x.id === a1)!;
    expect(moved.filename).toBe('renamed.png');
    expect(moved.folder).toBe('elsewhere');

    // Rename a folder: nested assets + folder rows follow the prefix rewrite.
    await call(world.env, 'PATCH', '/asset-folders', { token: tok(), body: { from: 'mgmt', to: 'managed' } });
    list = (await call(world.env, 'GET', '/assets', { token: tok() })).body as typeof list;
    expect(list.assets.find((x) => x.id === a2)!.folder).toBe('managed/deep');
    expect(list.folders).not.toContain('mgmt');

    // Delete a folder: contained assets re-parent (deep → root-level 'deep').
    await call(world.env, 'DELETE', '/asset-folders', { token: tok(), body: { name: 'managed' } });
    list = (await call(world.env, 'GET', '/assets', { token: tok() })).body as typeof list;
    expect(list.assets.find((x) => x.id === a2)!.folder).toBe('deep');
    expect(list.folders).not.toContain('managed');

    // Delete an asset: gone from the list AND the public URL 404s.
    await call(world.env, 'DELETE', `/assets/${a2}`, { token: tok() });
    list = (await call(world.env, 'GET', '/assets', { token: tok() })).body as typeof list;
    expect(list.assets.some((x) => x.id === a2)).toBe(false);
    const app = createApp({ pool: world.pool });
    expect((await app.request(`/assets/${a2}`)).status).toBe(404);

    // Cross-workspace management is 403/404.
    const foreign = tokenFor(USER, OTHER);
    expect([403, 404]).toContain((await call(world.env, 'DELETE', `/assets/${a1}`, { token: foreign })).status);
  });

  it('rejects non-image mimes and oversized payloads', async () => {
    const bad = await call(world.env, 'POST', '/assets', {
      token: tok(),
      body: { filename: 'x.exe', mime: 'application/octet-stream', data_base64: PNG_B64 },
    });
    expect(bad.status).toBe(400);
    const big = await call(world.env, 'POST', '/assets', {
      token: tok(),
      body: { filename: 'big.png', mime: 'image/png', data_base64: 'A'.repeat(3_000_001) },
    });
    expect(big.status).toBe(413);
  });
});
