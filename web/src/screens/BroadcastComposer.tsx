// BroadcastComposer (§12, §9A): pick a segment audience + template, create a
// broadcast, and send it (the server runs the broadcast core; SQS mocked locally).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';

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
      body: {
        name: name || 'Untitled broadcast',
        audience_kind: 'segment',
        audience_ref: segId,
        template_id: tplId,
      },
    });
    await reload();
  };

  const send = async (id: string) => {
    const res = await api.post<{ result: { result?: string } }>(`/broadcasts/${id}/send`, {});
    setLastResult(JSON.stringify(res.result));
    await reload();
  };

  return (
    <section data-testid="broadcast-composer">
      <h1>Broadcast composer</h1>
      <input
        data-testid="broadcast-name"
        placeholder="Broadcast name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <select
        data-testid="broadcast-segment"
        value={segId}
        onChange={(e) => setSegId((e.target as HTMLSelectElement).value)}
      >
        <option value="">Select segment</option>
        {segments.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <select
        data-testid="broadcast-template"
        value={tplId}
        onChange={(e) => setTplId((e.target as HTMLSelectElement).value)}
      >
        <option value="">Select template</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <button data-testid="create-broadcast" type="button" onClick={create}>
        Create broadcast
      </button>

      <ul data-testid="broadcast-list">
        {broadcasts.map((b) => (
          <li data-testid="broadcast-item" key={b.id}>
            <span data-testid="broadcast-status">{b.name} — {b.status}</span>
            <button data-testid="send-broadcast" type="button" onClick={() => send(b.id)}>
              Send
            </button>
          </li>
        ))}
      </ul>
      {lastResult ? <p data-testid="send-result">{lastResult}</p> : null}
    </section>
  );
}
