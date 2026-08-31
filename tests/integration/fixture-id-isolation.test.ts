// Two integration test files must never use the SAME uuid.
//
// The integration tier shares ONE database, and every file cleans up by id —
// `DELETE FROM workspaces WHERE id = $1` in a beforeAll or afterAll. Files run in
// parallel, so when two of them name the same workspace or company, one file's
// teardown deletes the other's fixtures mid-run. What you see is the OTHER file
// failing, with an error that has nothing to do with it: a 403 because the
// membership row vanished, or a foreign-key violation because the company did.
//
// That happened twice in one afternoon, both times costing more to diagnose than
// to fix, which is why it is asserted here rather than left as a convention to
// remember. Unit tests are excluded: they touch no database, so sharing a tidy
// `11111111-…` id between them is free.
//
// No database needed — this reads the test files themselves.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '../..');
const UUID = /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g;

/** Every *.integration.test.ts under the repo, by absolute path. */
function integrationTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) integrationTestFiles(full, out);
    else if (entry.endsWith('.integration.test.ts')) out.push(full);
  }
  return out;
}

describe('integration fixtures are isolated from each other', () => {
  const files = [
    ...integrationTestFiles(join(REPO, 'services')),
    ...integrationTestFiles(join(REPO, 'tests')),
    ...integrationTestFiles(join(REPO, 'packages')),
  ];

  it('finds the integration suite', () => {
    // A guard on the guard: if the glob ever stops matching, this test would pass
    // by looking at nothing.
    expect(files.length).toBeGreaterThan(50);
  });

  it('no uuid is used by two different files', () => {
    const owners = new Map<string, Set<string>>();
    for (const file of files) {
      const name = file.slice(REPO.length + 1);
      for (const match of readFileSync(file, 'utf8').matchAll(UUID)) {
        const uuid = match[1]!;
        const set = owners.get(uuid) ?? new Set<string>();
        set.add(name);
        owners.set(uuid, set);
      }
    }

    const shared = [...owners.entries()]
      .filter(([, who]) => who.size > 1)
      .map(([uuid, who]) => `${uuid} used by ${[...who].sort().join(' and ')}`);

    expect(
      shared,
      'These files share fixture ids. Whichever runs first will have its rows deleted by the ' +
        "other's cleanup, and the failure will surface somewhere unrelated. Give each file its " +
        'own uuid prefix.',
    ).toEqual([]);
  });
});
