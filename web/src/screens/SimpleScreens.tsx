// Lean read-mostly screens (§12): Dashboards, ProfileExplorer, SuppressionList,
// BillingUsageView. Each fetches its workspace-scoped data from the API (the
// server scopes by the token's workspace_id) and renders a simple table/list.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';

export function Dashboards() {
  const [s, setS] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    void api.get<Record<string, number>>('/dashboards/summary').then(setS);
  }, []);
  return (
    <section data-testid="dashboards">
      <h1>Dashboards</h1>
      {s ? (
        <ul>
          <li data-testid="dash-profiles">Profiles: {s.profiles}</li>
          <li data-testid="dash-segments">Segments: {s.segments}</li>
          <li data-testid="dash-broadcasts">Broadcasts: {s.broadcasts}</li>
          <li data-testid="dash-messages">Messages sent: {s.messages_sent}</li>
        </ul>
      ) : (
        <p>Loading…</p>
      )}
    </section>
  );
}

interface Profile {
  id: string;
  external_id: string;
  email: string;
  email_status: string;
}

export function ProfileExplorer() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  useEffect(() => {
    void api.get<{ profiles: Profile[] }>('/profiles').then((r) => setProfiles(r.profiles));
  }, []);
  return (
    <section data-testid="profile-explorer">
      <h1>Profiles</h1>
      <table>
        <tbody>
          {profiles.map((p) => (
            <tr data-testid="profile-row" key={p.id}>
              <td>{p.external_id}</td>
              <td>{p.email}</td>
              <td>{p.email_status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface Suppression {
  email: string;
  reason: string;
}

export function SuppressionList() {
  const [items, setItems] = useState<Suppression[]>([]);
  useEffect(() => {
    void api.get<{ suppressions: Suppression[] }>('/suppressions').then((r) => setItems(r.suppressions));
  }, []);
  return (
    <section data-testid="suppression-list">
      <h1>Suppressions</h1>
      <ul>
        {items.map((s, i) => (
          <li data-testid="suppression-row" key={i}>
            {s.email} — {s.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Usage {
  period: string;
  metric: string;
  value: number;
}

export function BillingUsageView() {
  const [usage, setUsage] = useState<Usage[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<{ usage: Usage[] }>('/billing/usage')
      .then((r) => setUsage(r.usage))
      .catch((e) => setError((e as { error?: string })?.error ?? 'error'));
  }, []);
  return (
    <section data-testid="billing-usage">
      <h1>Billing &amp; usage</h1>
      {error ? <p data-testid="billing-error">{error}</p> : null}
      <ul>
        {usage.map((u, i) => (
          <li data-testid="usage-row" key={i}>
            {u.period} {u.metric}: {u.value}
          </li>
        ))}
      </ul>
    </section>
  );
}
