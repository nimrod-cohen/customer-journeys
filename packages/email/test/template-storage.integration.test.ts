import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildTemplateUpsert } from '../src/template.js';
import { compileMjml } from '../src/mjml.js';

// §11 / §16A integration tier — REAL local Postgres (DB is NOT mocked). The
// save path compiles MJML then upserts both forms into email_templates. Proves
// idempotency on (workspace_id, name) and workspace scoping (a same-named save
// in another workspace never collides).
const RUN = hasDatabaseUrl();

// File-local fixture namespace.
const wsA = 'e1aae1aa-0000-0000-0000-0000000000a1';
const wsB = 'e1aae1aa-0000-0000-0000-0000000000b2';

async function cleanup(admin: Pool): Promise<void> {
  for (const ws of [wsA, wsB]) {
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }
}

describe.skipIf(!RUN)('email_templates storage (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  const mjml = `<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`;

  it('stores compiled HTML + source MJML', async () => {
    const html = compileMjml(mjml);
    const stmt = buildTemplateUpsert(wsA, 'welcome', mjml, html);
    await admin.query(stmt.text, stmt.values);

    const { rows } = await admin.query(
      'SELECT mjml, compiled_html FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [wsA, 'welcome'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mjml).toBe(mjml);
    expect(rows[0].compiled_html).toContain('<html');
  });

  it('repeated save of the same name updates in place (one row)', async () => {
    const html2 = compileMjml(
      `<mjml><mj-body><mj-section><mj-column><mj-text>Updated</mj-text></mj-column></mj-section></mj-body></mjml>`,
    );
    const stmt = buildTemplateUpsert(wsA, 'welcome', '<mjml-updated/>', html2);
    await admin.query(stmt.text, stmt.values);

    const { rows } = await admin.query(
      'SELECT mjml, compiled_html FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [wsA, 'welcome'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mjml).toBe('<mjml-updated/>');
    expect(rows[0].compiled_html.toLowerCase()).toContain('updated');
  });

  it('a same-named save in another workspace does not collide (scoping)', async () => {
    const html = compileMjml(mjml);
    const stmt = buildTemplateUpsert(wsB, 'welcome', mjml, html);
    await admin.query(stmt.text, stmt.values);

    const a = await admin.query(
      'SELECT count(*)::int n FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [wsA, 'welcome'],
    );
    const b = await admin.query(
      'SELECT count(*)::int n FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [wsB, 'welcome'],
    );
    expect(a.rows[0].n).toBe(1);
    expect(b.rows[0].n).toBe(1);
    // ws-A still has its updated content, untouched by ws-B's write.
    const aRow = await admin.query(
      'SELECT mjml FROM email_templates WHERE workspace_id = $1 AND name = $2',
      [wsA, 'welcome'],
    );
    expect(aRow.rows[0].mjml).toBe('<mjml-updated/>');
  });
});
