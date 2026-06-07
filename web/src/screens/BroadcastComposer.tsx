// BroadcastComposer (§12, §9A): pick a segment audience + template, create a
// broadcast, and send it (the server runs the broadcast core; SQS mocked locally).
// (Visual redesign; all data-testid attributes preserved.)
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, EmptyState, toneFor } from '../ui/kit.js';

interface Segment {
  id: string;
  name: string;
}
interface Template {
  id: string;
  name: string;
}
interface Broadcast {
  id: string;
  name: string;
  status: string;
}

export function BroadcastComposer() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [name, setName] = useState('');
  const [segId, setSegId] = useState('');
  const [tplId, setTplId] = useState('');
  const [lastResult, setLastResult] = useState('');

  const reload = async () => {
    const [s, t, b] = await Promise.all([
      api.get<{ segments: Segment[] }>('/segments'),
      api.get<{ templates: Template[] }>('/templates'),
      api.get<{ broadcasts: Broadcast[] }>('/broadcasts'),
    ]);
    setSegments(s.segments);
    setTemplates(t.templates);
    setBroadcasts(b.broadcasts);
  };

  useEffect(() => {
    void reload();
  }, []);

  const create = async () => {
    await api.post('/broadcasts', {
      body: { name: name || 'Untitled broadcast', audience_kind: 'segment', audience_ref: segId, template_id: tplId },
    });
    setName('');
    await reload();
  };

  const send = async (id: string) => {
    const res = await api.post<{ result: { result?: string } }>(`/broadcasts/${id}/send`, {});
    setLastResult(JSON.stringify(res.result));
    await reload();
  };

  return (
    <section data-testid="broadcast-composer">
      <PageHeader title="Broadcasts" subtitle="Send a one-off email to a segment or manual group." />

      <Card class="p-5">
        <div class="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <Field label="Name">
            <Input
              data-testid="broadcast-name"
              placeholder="Spring announcement"
              value={name}
              onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Audience">
            <Select
              data-testid="broadcast-segment"
              value={segId}
              onChange={(e: Event) => setSegId((e.target as HTMLSelectElement).value)}
            >
              <option value="">Select segment</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Template">
            <Select
              data-testid="broadcast-template"
              value={tplId}
              onChange={(e: Event) => setTplId((e.target as HTMLSelectElement).value)}
            >
              <option value="">Select template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button data-testid="create-broadcast" onClick={create}>
            Create
          </Button>
        </div>
      </Card>

      <h2 class="mb-3 mt-7 text-base font-bold text-ink-900">Broadcasts</h2>
      {broadcasts.length ? (
        <ul data-testid="broadcast-list" class="space-y-2">
          {broadcasts.map((b) => (
            <li
              data-testid="broadcast-item"
              key={b.id}
              class="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
            >
              <span data-testid="broadcast-status" class="flex items-center gap-3">
                <span class="font-medium text-ink-900">{b.name}</span>
                <Badge tone={toneFor(b.status)}>{b.status}</Badge>
              </span>
              <Button data-testid="send-broadcast" variant="secondary" size="sm" onClick={() => send(b.id)}>
                Send
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="broadcast-list">
          <EmptyState>No broadcasts yet — create one above.</EmptyState>
        </div>
      )}

      {lastResult ? (
        <p
          data-testid="send-result"
          class="mt-4 rounded-lg bg-stone-900 px-3 py-2 font-mono text-xs text-brand-200"
        >
          {lastResult}
        </p>
      ) : null}
    </section>
  );
}
