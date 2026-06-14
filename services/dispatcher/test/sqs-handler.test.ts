import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ProdSesEmailClient } from '@cdp/email';
import { makeDispatcherHandler, type HandlerDeps, type SqsEvent } from '../src/handler.js';
import type { Reader } from '../src/dispatch.js';

// §9 / §16A — thin SQS handler. We use SYNTHETIC events (no LocalStack this
// phase) and never assert SQS ordering/delivery (that's SQS's job). We assert:
//   - a successful record is ACKed (omitted from batchItemFailures),
//   - a malformed body → reported as a failure (→ redrive → DLQ),
//   - a retryable failure under the attempts ceiling → reported,
//   - a retryable failure at/over the ceiling → ACKed (stop redriving → DLQ).
const ses = mockClient(SESv2Client);

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROFILE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface Scenario {
  outboxStatus: string;
  attempts: number;
  sesFails: boolean;
}

function makeDeps(scn: Scenario): HandlerDeps {
  const reader: Reader = {
    async query<T>(text: string): Promise<{ rows: T[] }> {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('SELECT id, workspace_id, profile_id, campaign_id')) {
        return {
          rows: [
            {
              id: 'ob-1',
              workspace_id: WS,
              profile_id: PROFILE,
              campaign_id: null,
              template_id: 'tpl',
              dedupe_key: 'dk',
              attempts: scn.attempts,
              payload: { subject: 'Hi', merge: {}, frequency_cap_per_days: null, quiet_hours: null },
            } as unknown as T,
          ],
        };
      }
      if (t.startsWith("UPDATE outbox SET status = 'sending'")) {
        if (scn.outboxStatus !== 'pending') return { rows: [] };
        scn.outboxStatus = 'sending';
        return { rows: [{ id: 'ob-1' } as unknown as T] };
      }
      if (t.startsWith('SELECT id, status, sending_identity, settings FROM workspaces')) {
        return {
          rows: [
            {
              id: WS,
              status: 'active',
              sending_identity: { verified: true, from_domain: 'mail.acme.com', config_set: 'cs' },
              settings: null,
            } as unknown as T,
          ],
        };
      }
      if (t.startsWith('SELECT id, email, external_id, email_status, created_at, attributes')) {
        return {
          rows: [
            { id: PROFILE, email: 'r@example.com', external_id: null, email_status: 'active', created_at: null, attributes: {} } as unknown as T,
          ],
        };
      }
      if (t.startsWith('SELECT compiled_html')) {
        return { rows: [{ compiled_html: '<html>Hi</html>' } as unknown as T] };
      }
      if (t.startsWith('SELECT EXISTS')) return { rows: [{ suppressed: false } as unknown as T] };
      if (t.startsWith('SELECT count(*)::int')) return { rows: [{ n: 0 } as unknown as T] };
      if (t.startsWith('SELECT attempts FROM outbox')) {
        return { rows: [{ attempts: scn.attempts } as unknown as T] };
      }
      return { rows: [] };
    },
  };
  return {
    reader,
    ses: new ProdSesEmailClient(ses as unknown as SESv2Client),
    async runInWorkspaceTx() {
      /* no-op fake */
    },
    now: () => new Date('2026-06-10T12:00:00.000Z'),
    unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    linkTrackingBaseUrl: 'https://api.cdp.example',
  };
}

function evt(...bodies: string[]): SqsEvent {
  return { Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) };
}

describe('makeDispatcherHandler (synthetic SQS events)', () => {
  beforeEach(() => {
    ses.reset();
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
  });

  it('acks a successful send (no batchItemFailures)', async () => {
    const handler = makeDispatcherHandler(makeDeps({ outboxStatus: 'pending', attempts: 0, sesFails: false }));
    const res = await handler(evt(JSON.stringify({ outbox_id: 'ob-1' })));
    expect(res.batchItemFailures).toHaveLength(0);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it('reports a malformed body as a batch item failure', async () => {
    const handler = makeDispatcherHandler(makeDeps({ outboxStatus: 'pending', attempts: 0, sesFails: false }));
    const res = await handler(evt('not json'));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm0' }]);
  });

  it('reports a retryable SES failure for redrive when under the attempts ceiling', async () => {
    ses.reset();
    ses.on(SendEmailCommand).rejects(new Error('throttled'));
    const handler = makeDispatcherHandler(makeDeps({ outboxStatus: 'pending', attempts: 1, sesFails: true }));
    const res = await handler(evt(JSON.stringify({ outbox_id: 'ob-1' })));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm0' }]);
  });

  it('acks a retryable failure at/over the attempts ceiling (stop redriving → DLQ)', async () => {
    ses.reset();
    ses.on(SendEmailCommand).rejects(new Error('throttled'));
    const handler = makeDispatcherHandler(
      makeDeps({ outboxStatus: 'pending', attempts: 5, sesFails: true }),
    );
    const res = await handler(evt(JSON.stringify({ outbox_id: 'ob-1' })));
    expect(res.batchItemFailures).toHaveLength(0);
  });
});
