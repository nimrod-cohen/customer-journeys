// OnboardingWizard (§10A): the sending-domain stepper. Step 1 enter domain →
// start (SES identity + DKIM, returns records). Step 2 show copy-paste records
// with live status badges → check (re-reads SES DKIM + DNS). Step 3 activate
// (gated on SES DKIM verified). SES/DNS are mocked locally; the gate logic is the
// real onboarding core server-side.
import { useState } from 'preact/hooks';
import { api } from '../store/session.js';

interface DnsRecord {
  role: string;
  type: string;
  name: string;
  value: string;
}
interface RecordCheck {
  role: string;
  name: string;
  status: string;
}

export function OnboardingWizard() {
  const [domain, setDomain] = useState('');
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [checks, setChecks] = useState<RecordCheck[]>([]);
  const [dkimVerified, setDkimVerified] = useState<boolean | null>(null);
  const [activated, setActivated] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');

  const start = async () => {
    const r = await api.post<{ records: { records: DnsRecord[] } }>('/sending-domain/start', {
      body: { from_domain: domain.trim() },
    });
    setRecords(r.records.records);
  };

  const check = async () => {
    const r = await api.post<{ dkimVerified: boolean; recordChecks: RecordCheck[] }>(
      '/sending-domain/check',
      {},
    );
    setDkimVerified(r.dkimVerified);
    setChecks(r.recordChecks);
  };

  const activate = async () => {
    const r = await api.post<{ decision: { allowed: boolean; reason?: string } }>(
      '/sending-domain/activate',
      {},
    );
    setActivated(r.decision.allowed);
    setReason(r.decision.reason ?? '');
  };

  const statusFor = (name: string) => checks.find((c) => c.name === name)?.status ?? 'pending';

  return (
    <section data-testid="onboarding-wizard">
      <h1>Sending domain onboarding</h1>

      <ol>
        <li data-testid="step-1">
          <h2>1. Enter sending domain</h2>
          <input
            data-testid="domain-input"
            placeholder="mail.yourcompany.com"
            value={domain}
            onInput={(e) => setDomain((e.target as HTMLInputElement).value)}
          />
          <button data-testid="start-domain" type="button" onClick={start}>
            Start
          </button>
        </li>

        <li data-testid="step-2">
          <h2>2. Publish DNS records</h2>
          <table>
            <tbody>
              {records.map((rec, i) => (
                <tr data-testid="dns-record" key={i}>
                  <td>{rec.type}</td>
                  <td>{rec.name}</td>
                  <td>{rec.value}</td>
                  <td data-testid="record-status">{statusFor(rec.name)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button data-testid="check-domain" type="button" onClick={check} disabled={records.length === 0}>
            Check now
          </button>
          {dkimVerified !== null ? (
            <p data-testid="dkim-status">DKIM verified: {String(dkimVerified)}</p>
          ) : null}
        </li>

        <li data-testid="step-3">
          <h2>3. Activate</h2>
          <button data-testid="activate-domain" type="button" onClick={activate}>
            Activate sending
          </button>
          {activated !== null ? (
            <p data-testid="activate-result">
              {activated ? 'Activated — sending enabled' : `Not activated: ${reason}`}
            </p>
          ) : null}
        </li>
      </ol>
    </section>
  );
}
