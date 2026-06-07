// CampaignBuilder (§12, §9B): a lean visual workflow builder over the node DSL
// (trigger/wait/condition/action/exit). Assembles the definition via the pure
// builder and saves it (the server validates with validateCampaignDefinition).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { buildDefinition, starterNodes, type BuilderNode } from '../campaigns/builder.js';

interface Template {
  id: string;
  name: string;
}
interface Campaign {
  id: string;
  name: string;
  status: string;
}

export function CampaignBuilder() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState<BuilderNode[]>([]);
  const [error, setError] = useState('');

  const reload = async () => {
    const [t, c] = await Promise.all([
      api.get<{ templates: Template[] }>('/templates'),
      api.get<{ campaigns: Campaign[] }>('/campaigns'),
    ]);
    setTemplates(t.templates);
    setCampaigns(c.campaigns);
    if (t.templates[0]) setNodes(starterNodes(t.templates[0].id));
  };

  useEffect(() => {
    void reload();
  }, []);

  const addWait = () => {
    // Insert a wait between trigger and the first action (lean demo edit).
    const tpl = templates[0]?.id ?? '';
    setNodes([
      { id: 'trigger', type: 'trigger', kind: 'segment_entry', next: 'wait1' },
      { id: 'wait1', type: 'wait', delaySeconds: 172800, next: 'send' },
      { id: 'send', type: 'action', kind: 'send', templateId: tpl, next: 'done' },
      { id: 'done', type: 'exit' },
    ]);
  };

  const save = async () => {
    setError('');
    try {
      const def = buildDefinition(nodes);
      await api.post('/campaigns', { body: { name: name || 'Untitled campaign', definition: def } });
      await reload();
    } catch (err) {
      setError((err as { error?: string })?.error ?? String(err));
    }
  };

  return (
    <section data-testid="campaign-builder">
      <h1>Campaign builder</h1>
      <input
        data-testid="campaign-name"
        placeholder="Campaign name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <div data-testid="campaign-canvas">
        {nodes.map((n) => (
          <span data-testid={`node-${n.type}`} key={n.id} style={{ marginRight: 8 }}>
            [{n.type}]
          </span>
        ))}
      </div>
      <button data-testid="add-wait-node" type="button" onClick={addWait}>
        Add wait step
      </button>
      <button data-testid="save-campaign" type="button" onClick={save} disabled={nodes.length === 0}>
        Save campaign
      </button>
      {error ? (
        <p data-testid="campaign-error" style={{ color: 'crimson' }}>
          {error}
        </p>
      ) : null}
      <ul data-testid="campaign-list">
        {campaigns.map((c) => (
          <li data-testid="campaign-item" key={c.id}>
            {c.name} — {c.status}
          </li>
        ))}
      </ul>
    </section>
  );
}
