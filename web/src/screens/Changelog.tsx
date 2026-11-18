// "What's new": every release, newest first, in plain language. Static content from
// ../changelog.ts (the deployed build has no git history). Reached by clicking the
// version number in the sidebar footer; open to any signed-in user.
import { CHANGELOG } from '../changelog.js';
import { Badge, Card, PageHeader } from '../ui/kit.js';

/** YYYY-MM-DD → dd/mm/yyyy, the app's date format. */
export function formatChangelogDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function Changelog() {
  return (
    <section data-testid="changelog">
      <PageHeader title="What’s new" subtitle="What changed in each version, newest first." />
      <Card class="divide-y divide-stone-200">
        {CHANGELOG.map((entry) => (
          <article
            key={entry.version}
            data-testid={`changelog-${entry.version}`}
            class="flex flex-col gap-2 p-4 sm:flex-row sm:gap-6 sm:p-5"
          >
            <div class="flex shrink-0 items-center gap-2 sm:w-40 sm:flex-col sm:items-start sm:gap-1">
              <span class="font-mono text-sm font-semibold text-ink-950">v{entry.version}</span>
              {entry.version === __APP_VERSION__ ? <Badge tone="success">current</Badge> : null}
              {entry.date ? <span class="text-xs text-stone-500">{formatChangelogDate(entry.date)}</span> : null}
            </div>
            <ul class="min-w-0 flex-1 list-disc space-y-1 pl-5 text-sm text-stone-700">
              {entry.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </article>
        ))}
      </Card>
    </section>
  );
}
