import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, applyMigrations, hasDatabaseUrl } from '@cdp/db';
import { saveTemplate } from '@cdp/service-image';
import { designToMjml } from '../src/email-designer/mjml-serializer.js';
import type { EmailDesign } from '../src/email-designer/model.js';

/** Build the {name, mjml} save payload from a design (the new designer's path). */
function buildSaveTemplatePayload(design: EmailDesign, name: string): { name: string; mjml: string } {
  return { name, mjml: designToMjml(design) };
}

// §11 / §16A tier 2: the WHOLE save path against a REAL local Postgres (never
// mock the DB). The editor's pure payload builder produces {name, mjml}; the
// SERVER core compiles MJML→HTML and persists BOTH columns, workspace-scoped.
// We prove: mjml stored verbatim, compiled_html is real HTML (server-produced),
// the upsert is idempotent per (workspace, name), and isolation holds. Gated on
// DATABASE_URL; skips cleanly without it.

type Pool = ReturnType<typeof adminPool>;

const WS_A = '0e2e0012-0000-4000-8000-000000000001';
const WS_B = '0e2e0012-0000-4000-8000-000000000002';
const ALL = [WS_A, WS_B];

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const state: EmailDesign = {
  version: 1,
  rows: [
    {
      id: 'row-1',
      elements: [
        { id: 'e1', type: 'text', props: { html: 'Welcome aboard' } },
        { id: 'e2', type: 'image', props: { src: 'https://images.cdp.example/ws/hero.png', alt: 'Hero' } },
      ],
    },
  ],
};

function runner(pool: Pool) {
  return async (stmt: { text: string; values: unknown[] }) => {
    await pool.query(stmt.text, stmt.values);
  };
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM email_templates WHERE workspace_id = ANY($1)', [ALL]);
  await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [ALL]);
}

describeMaybe('save-template path (editor payload → server compile → real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    const { rows } = await pool.query("SELECT to_regclass('public.email_templates') IS NOT NULL AS exists");
    if (!rows[0].exists) await applyMigrations(pool);
    await cleanup(pool);
    for (const ws of ALL) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1, 'TPL', 'active')", [ws]);
    }
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it('persists the editor MJML + SERVER-compiled HTML, workspace-scoped', async () => {
    const payload = buildSaveTemplatePayload(state, 'Welcome');
    const result = await saveTemplate(runner(pool), {
      workspaceId: WS_A,
      name: payload.name,
      mjml: payload.mjml,
    });

    // Server produced real HTML from the editor's MJML.
    expect(result.compiledHtml).toMatch(/<html/i);

    const { rows } = await pool.query(
      'SELECT mjml, compiled_html FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [WS_A, 'Welcome'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mjml).toBe(payload.mjml);
    expect(rows[0].mjml.startsWith('<mjml>')).toBe(true);
    expect(rows[0].compiled_html).toMatch(/<html/i);
    expect(rows[0].compiled_html).toContain('https://images.cdp.example/ws/hero.png');
  });

  it('is idempotent per (workspace, name): a re-save updates, not duplicates', async () => {
    const next: EmailDesign = {
      version: 1,
      rows: [{ id: 'row-1', elements: [{ id: 'e1', type: 'text', props: { html: 'Updated copy' } }] }],
    };
    const payload = buildSaveTemplatePayload(next, 'Welcome');
    await saveTemplate(runner(pool), { workspaceId: WS_A, name: 'Welcome', mjml: payload.mjml });

    const { rows } = await pool.query(
      'SELECT mjml FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [WS_A, 'Welcome'],
    );
    expect(rows).toHaveLength(1); // still one row
    expect(rows[0].mjml).toContain('Updated copy');
  });

  it('isolates workspaces: same name in B is a separate row', async () => {
    const payload = buildSaveTemplatePayload(state, 'Welcome');
    await saveTemplate(runner(pool), { workspaceId: WS_B, name: 'Welcome', mjml: payload.mjml });

    const a = await pool.query('SELECT id FROM email_templates WHERE workspace_id = $1 AND name = $2', [WS_A, 'Welcome']);
    const b = await pool.query('SELECT id FROM email_templates WHERE workspace_id = $1 AND name = $2', [WS_B, 'Welcome']);
    expect(a.rows[0].id).not.toBe(b.rows[0].id);
  });

  it('rejects invalid MJML server-side (broken email HTML never stored)', async () => {
    await expect(
      saveTemplate(runner(pool), { workspaceId: WS_A, name: 'Bad', mjml: '<not-mjml>oops' }),
    ).rejects.toThrow();
    const { rows } = await pool.query(
      'SELECT 1 FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [WS_A, 'Bad'],
    );
    expect(rows).toHaveLength(0);
  });
});
