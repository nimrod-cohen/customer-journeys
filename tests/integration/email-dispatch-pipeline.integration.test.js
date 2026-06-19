// Cross-phase email/dispatch integration (§9, §10, §10A, §16A, §18).
//
// Proves phases 6–8 work TOGETHER against a REAL local Postgres, driving the
// ACTUAL production cores in sequence (no re-implementation):
//   onboarding (startDomain → activate, SES+DNS mocked) →
//   dispatcher  (dispatchOutbox, SES mocked) →
//   feedback    (handleNotification, SNS notification mocked) →
//   unsubscribe (parse + suppression write) → dispatcher again.
//
// Every service runs as the SERVICE ROLE (bypasses RLS) so isolation is proven
// IN CODE (workspace_id bound at $1) — we run on adminPool() and never SET ROLE,
// exactly as in production. Only SES + the SNS/SES notification payloads are
// mocked at the boundary; the DB is real (migrations incl. 0007 applied).
//
// Gated on DATABASE_URL; skips cleanly when no Postgres is reachable.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminPool, applyMigrations, hasDatabaseUrl } from '@cdp/db';
// Onboarding (real core).
import { startDomain } from '@cdp/service-onboarding';
import { activate } from '@cdp/service-onboarding';
import { makeWorkspaceTxRunner, makeSendingIdentityReader, configSetNameFor, } from '@cdp/service-onboarding';
import { buildDnsRecordSet } from '@cdp/service-onboarding';
// Dispatcher (real core).
import { dispatchOutbox, } from '@cdp/service-dispatcher';
import { runStatementsInWorkspaceTx } from '@cdp/service-dispatcher';
// Feedback (real core).
import { handleNotification, } from '@cdp/service-feedback';
import { runFeedbackStatementsInTx } from '@cdp/service-feedback';
// Unsubscribe (real core).
import { parseUnsubscribeRequest, buildUnsubscribeSuppression, runUnsubscribeInWorkspaceTx, } from '@cdp/service-unsubscribe';
// File-local namespace — workspaces / ses_message_id / event ids are GLOBAL or
// per-(ws,ses_message_id), so each integration file uses unique ids to stay
// parallel-safe with the other integration files sharing this Postgres.
const WS_A = '0e2e0008-0000-4000-8000-000000000001'; // active sender
const WS_B = '0e2e0008-0000-4000-8000-000000000002'; // isolation peer
const WS_ONB = '0e2e0008-0000-4000-8000-000000000003'; // onboarding → active
const WS_GATE = '0e2e0008-0000-4000-8000-000000000004'; // never activated (gate)
const WS_REP = '0e2e0008-0000-4000-8000-000000000005'; // reputation-breach offender
const DOMAIN_ONB = 'mail.onb-e2e.test';
const REGION = 'us-east-1';
const DKIM_TOKENS = ['e2etok1', 'e2etok2', 'e2etok3'];
const UNSUB_BASE = 'https://api.cdp.example/unsubscribe';
// Unique SES message ids across the file (messages_log/email_events are keyed by
// (workspace_id, ses_message_id, type) — keep them distinct & deterministic).
let sesSeq = 0;
const nextSesId = () => `e2e8-ses-${String(++sesSeq).padStart(6, '0')}`;
const ALL_WS = [WS_A, WS_B, WS_ONB, WS_GATE, WS_REP];
const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;
// ── mocked boundaries (SES) ───────────────────────────────────────────────────
/** A counting SES fake — records every sendEmail; never sends real mail. */
class CountingSes {
    sends = [];
    async sendEmail(input) {
        this.sends.push(input);
        return { sesMessageId: nextSesId() };
    }
    async createDomainIdentity(domain) {
        return { identity: domain, dkimTokens: DKIM_TOKENS };
    }
    async getIdentityVerificationAttributes() {
        return { dkimStatus: 'SUCCESS', signingEnabled: true, dkimTokens: DKIM_TOKENS };
    }
    async createConfigurationSet() {
        /* no-op */
    }
    async provisionDedicatedIp() {
        /* no-op */
    }
}
/** Onboarding SES fake parameterized by the DKIM status it reports (the gate). */
function onboardingSes(status) {
    return {
        createDomainIdentity: vi.fn(async (d) => ({ identity: d, dkimTokens: DKIM_TOKENS })),
        getIdentityVerificationAttributes: vi.fn(async () => ({
            dkimStatus: status,
            signingEnabled: status === 'SUCCESS',
            dkimTokens: DKIM_TOKENS,
        })),
        createConfigurationSet: vi.fn(async () => { }),
        sendEmail: vi.fn(async () => ({ sesMessageId: nextSesId() })),
    };
}
/** DNS resolver that returns the expected value for every REQUIRED non-DKIM record. */
function dnsRequiredFound(fromDomain, mailFrom) {
    const set = buildDnsRecordSet(fromDomain, DKIM_TOKENS, mailFrom, REGION);
    const m = new Map();
    for (const r of set.records) {
        if (r.required && r.role !== 'dkim')
            m.set(`${r.name}|${r.type}`, [r.value]);
    }
    return {
        async resolve(name, type) {
            return m.get(`${name}|${type}`) ?? [];
        },
    };
}
// ── dependency wiring (real tx paths against real Postgres) ───────────────────
function dispatchDeps(pool, ses, now) {
    const reader = {
        query: (text, values) => pool.query(text, values),
    };
    return {
        reader,
        ses,
        runInWorkspaceTx: (ws, statements) => runStatementsInWorkspaceTx(pool, ws, statements),
        now: () => now,
        unsubscribeBaseUrl: UNSUB_BASE,
        linkTrackingBaseUrl: 'https://api.cdp.example',
    };
}
function feedbackDeps(pool) {
    const reader = {
        async query(text, values) {
            const res = await pool.query(text, values);
            return { rows: res.rows };
        },
    };
    return { reader, runInWorkspaceTx: (w, s) => runFeedbackStatementsInTx(pool, w, s) };
}
// ── DB helpers ────────────────────────────────────────────────────────────────
async function seedTemplate(pool, ws) {
    const t = await pool.query(`INSERT INTO email_templates (workspace_id, name, mjml, compiled_html)
     VALUES ($1,'t','<m/>','<html>Hi {{first_name}}</html>') RETURNING id`, [ws]);
    return t.rows[0].id;
}
async function seedProfile(pool, ws, ext, email) {
    const p = await pool.query(`INSERT INTO profiles (workspace_id, external_id, email, email_status)
     VALUES ($1,$2,$3,'active') RETURNING id`, [ws, ext, email]);
    return p.rows[0].id;
}
async function enqueueOutbox(pool, ws, profileId, templateId, dedupeKey) {
    const o = await pool.query(`INSERT INTO outbox (workspace_id, profile_id, template_id, dedupe_key, status, payload)
     VALUES ($1,$2,$3,$4,'pending',$5::jsonb) RETURNING id`, [ws, profileId, templateId, dedupeKey, JSON.stringify({ subject: 'Hi', merge: { first_name: 'Ada' } })]);
    return o.rows[0].id;
}
async function statusOf(pool, ws) {
    const { rows } = await pool.query('SELECT status FROM workspaces WHERE id = $1', [ws]);
    return rows[0].status;
}
async function isSuppressed(pool, ws, email) {
    const { rows } = await pool.query('SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2', [ws, email]);
    return rows.length > 0;
}
async function cleanup(pool) {
    await pool.query('DELETE FROM email_events WHERE workspace_id = ANY($1)', [ALL_WS]);
    await pool.query('DELETE FROM messages_log WHERE workspace_id = ANY($1)', [ALL_WS]);
    await pool.query('DELETE FROM usage_counters WHERE workspace_id = ANY($1)', [ALL_WS]);
    await pool.query('DELETE FROM outbox WHERE workspace_id = ANY($1)', [ALL_WS]);
    await pool.query('DELETE FROM suppressions WHERE workspace_id = ANY($1)', [ALL_WS]);
    await pool.query('DELETE FROM email_templates WHERE workspace_id = ANY($1)', [ALL_WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = ANY($1)', [ALL_WS]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [ALL_WS]);
    // global_hard_bounces is cross-workspace (keyed by email only) — clean by the
    // file-local recipient addresses we use below.
    await pool.query(`DELETE FROM global_hard_bounces WHERE email LIKE '%@e2e8.example'`);
}
describeMaybe('email/dispatch pipeline (onboard → gate → dispatch → feedback → suppress → isolate)', () => {
    let pool;
    beforeAll(async () => {
        pool = adminPool();
        const { rows } = await pool.query("SELECT to_regclass('public.workspaces') IS NOT NULL AS exists");
        if (!rows[0].exists)
            await applyMigrations(pool);
        await cleanup(pool);
        // WS_A: already active+verified sender (its own config set).
        await pool.query(`INSERT INTO workspaces (id, name, status, sending_identity)
       VALUES ($1,'WS A','active',$2::jsonb)`, [WS_A, JSON.stringify({ verified: true, from_domain: 'mail.a.e2e8', config_set: configSetNameFor(WS_A) })]);
        // WS_B: active+verified isolation peer.
        await pool.query(`INSERT INTO workspaces (id, name, status, sending_identity)
       VALUES ($1,'WS B','active',$2::jsonb)`, [WS_B, JSON.stringify({ verified: true, from_domain: 'mail.b.e2e8', config_set: configSetNameFor(WS_B) })]);
        // WS_ONB: starts in onboarding; the test drives it to active via the cores.
        await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'WS ONB','onboarding')", [WS_ONB]);
        // WS_GATE: stays in onboarding (never activated) — the gate test.
        await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'WS GATE','onboarding')", [WS_GATE]);
        // WS_REP: active+verified offender for the reputation-breach test.
        await pool.query(`INSERT INTO workspaces (id, name, status, sending_identity)
       VALUES ($1,'WS REP','active',$2::jsonb)`, [WS_REP, JSON.stringify({ verified: true, from_domain: 'mail.rep.e2e8', config_set: configSetNameFor(WS_REP) })]);
    });
    afterAll(async () => {
        await cleanup(pool);
        await pool.end();
    });
    it('1 — Onboard: startDomain → activate (SES SUCCESS + DNS) flips status active and canSend', async () => {
        const txRunner = makeWorkspaceTxRunner(pool);
        // start-domain (SES mocked): persists the in-progress identity, stays onboarding.
        await startDomain({ ses: onboardingSes('PENDING'), region: REGION, runInWorkspaceTx: txRunner }, { workspaceId: WS_ONB, fromDomain: DOMAIN_ONB });
        expect(await statusOf(pool, WS_ONB)).toBe('onboarding');
        // activate (SES DKIM SUCCESS + required DNS resolved) → active + verified.
        const deps = {
            ses: onboardingSes('SUCCESS'),
            dns: dnsRequiredFound(DOMAIN_ONB, `mail.${DOMAIN_ONB}`),
            identity: makeSendingIdentityReader(pool),
            region: REGION,
            runInWorkspaceTx: txRunner,
            configSetName: configSetNameFor,
        };
        const out = await activate(deps, { workspaceId: WS_ONB });
        expect(out.decision.allowed).toBe(true);
        expect(await statusOf(pool, WS_ONB)).toBe('active');
        const { rows } = await pool.query('SELECT sending_identity FROM workspaces WHERE id = $1', [WS_ONB]);
        const si = rows[0].sending_identity;
        expect(si.verified).toBe(true);
        expect(si.config_set).toBe(configSetNameFor(WS_ONB));
        // The now-active workspace can send through the real dispatcher.
        const ses = new CountingSes();
        const profileId = await seedProfile(pool, WS_ONB, 'onb-cust', 'onb@e2e8.example');
        const templateId = await seedTemplate(pool, WS_ONB);
        const outboxId = await enqueueOutbox(pool, WS_ONB, profileId, templateId, 'onb-send-1');
        const res = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T12:00:00Z')), outboxId);
        expect(res.result).toBe('send');
        expect(ses.sends).toHaveLength(1);
        expect(ses.sends[0].configurationSetName).toBe(configSetNameFor(WS_ONB));
    });
    it('2 — Gate: a dispatch for a NOT-active workspace is refused, SES never called', async () => {
        const ses = new CountingSes();
        const profileId = await seedProfile(pool, WS_GATE, 'gate-cust', 'gate@e2e8.example');
        const templateId = await seedTemplate(pool, WS_GATE);
        const outboxId = await enqueueOutbox(pool, WS_GATE, profileId, templateId, 'gate-send-1');
        const res = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T12:00:00Z')), outboxId);
        expect(res.result).toBe('refuse');
        expect(ses.sends).toHaveLength(0); // never sent
        const ob = await pool.query('SELECT status FROM outbox WHERE id = $1', [outboxId]);
        expect(ob.rows[0].status).toBe('refused');
        const ml = await pool.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [WS_GATE]);
        expect(ml.rows[0].n).toBe(0);
    });
    it('3 — Dispatch: active workspace sends once, writes messages_log + usage, SES gets the config set', async () => {
        const ses = new CountingSes();
        const profileId = await seedProfile(pool, WS_A, 'disp-cust', 'recipient@e2e8.example');
        const templateId = await seedTemplate(pool, WS_A);
        const outboxId = await enqueueOutbox(pool, WS_A, profileId, templateId, 'a-send-1');
        const res = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T12:00:00Z')), outboxId);
        expect(res.result).toBe('send');
        // SES called exactly once with WS_A's Configuration Set + rendered body.
        expect(ses.sends).toHaveLength(1);
        expect(ses.sends[0].configurationSetName).toBe(configSetNameFor(WS_A));
        expect(ses.sends[0].html).toBe('<html>Hi Ada</html>');
        expect(ses.sends[0].to).toBe('recipient@e2e8.example');
        const ml = await pool.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1 AND profile_id = $2', [WS_A, profileId]);
        expect(ml.rows[0].n).toBe(1);
        const uc = await pool.query("SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'emails_sent'", [WS_A]);
        expect(Number(uc.rows[0].value)).toBe(1);
        const ob = await pool.query('SELECT status FROM outbox WHERE id = $1', [outboxId]);
        expect(ob.rows[0].status).toBe('sent');
    });
    it('4 — Feedback: a hard-bounce SNS notification suppresses in-workspace + globally + marks profile/event', async () => {
        const recipient = 'recipient@e2e8.example'; // the WS_A recipient we just sent to
        const sesMsg = nextSesId();
        const res = await handleNotification(feedbackDeps(pool), {
            eventType: 'Bounce',
            bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: recipient }] },
            mail: { messageId: sesMsg, tags: { workspace_id: [WS_A] } },
        });
        expect(res.status).toBe('ok');
        expect(res.status === 'ok' && res.workspaceId).toBe(WS_A);
        // Per-workspace suppression (hard_bounce).
        const sup = await pool.query('SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2', [WS_A, recipient]);
        expect(sup.rows[0]?.reason).toBe('hard_bounce');
        // Global hard-bounce row.
        const glob = await pool.query('SELECT 1 FROM global_hard_bounces WHERE email = $1', [recipient]);
        expect(glob.rowCount).toBe(1);
        // Profile email_status flipped.
        const prof = await pool.query('SELECT email_status FROM profiles WHERE workspace_id = $1 AND email = $2', [WS_A, recipient]);
        expect(prof.rows[0]?.email_status).toBe('bounced');
        // email_events row recorded.
        const ev = await pool.query("SELECT type, sub_type FROM email_events WHERE workspace_id = $1 AND ses_message_id = $2", [WS_A, sesMsg]);
        expect(ev.rows[0]).toMatchObject({ type: 'bounce', sub_type: 'Permanent' });
    });
    it('5 — Suppression closes the loop: a new send to the suppressed recipient is SKIPPED (no SES)', async () => {
        const ses = new CountingSes();
        const profRow = await pool.query('SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2', [WS_A, 'recipient@e2e8.example']);
        const profileId = profRow.rows[0].id;
        const templateId = (await pool.query('SELECT id FROM email_templates WHERE workspace_id = $1 LIMIT 1', [WS_A])).rows[0].id;
        const outboxId = await enqueueOutbox(pool, WS_A, profileId, templateId, 'a-send-2-after-suppress');
        const res = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T13:00:00Z')), outboxId);
        expect(res.result).toBe('skip');
        expect(ses.sends).toHaveLength(0); // suppression short-circuits before SES
        const ob = await pool.query('SELECT status FROM outbox WHERE id = $1', [outboxId]);
        expect(ob.rows[0].status).toBe('skipped');
    });
    it('6a — Isolation: unsubscribe in A does NOT suppress the same email in B; B still sends', async () => {
        const shared = 'shared-person@e2e8.example';
        // The same person exists in both workspaces (overlapping email).
        await seedProfile(pool, WS_A, 'iso-a', shared);
        const bProfileId = await seedProfile(pool, WS_B, 'iso-b', shared);
        const bTemplateId = await seedTemplate(pool, WS_B);
        // Drive the REAL unsubscribe core off a workspace-scoped one-click link for A.
        const link = `${UNSUB_BASE}?workspace_id=${WS_A}&email=${encodeURIComponent(shared)}`;
        const parsed = parseUnsubscribeRequest('POST', link, 'List-Unsubscribe=One-Click');
        expect(parsed.valid).toBe(true);
        if (!parsed.valid)
            throw new Error('unreachable');
        await runUnsubscribeInWorkspaceTx(pool, parsed.workspaceId, [
            buildUnsubscribeSuppression(parsed.workspaceId, parsed.email, 'one-click'),
        ]);
        // A is suppressed; B is NOT (per-workspace scoping).
        expect(await isSuppressed(pool, WS_A, shared)).toBe(true);
        expect(await isSuppressed(pool, WS_B, shared)).toBe(false);
        // A send for B to the same email STILL goes through (B unaffected by A's unsub).
        const ses = new CountingSes();
        const outboxId = await enqueueOutbox(pool, WS_B, bProfileId, bTemplateId, 'b-send-1');
        const res = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T12:00:00Z')), outboxId);
        expect(res.result).toBe('send');
        expect(ses.sends).toHaveLength(1);
        expect(ses.sends[0].configurationSetName).toBe(configSetNameFor(WS_B));
    });
    it('6b — Isolation: a reputation breach auto-suspends ONLY the offender (peer A stays active)', async () => {
        // Seed enough sends for WS_REP that the rate denominator is trustworthy, then
        // a single hard bounce pushes its bounce rate over the critical threshold.
        const deps = feedbackDeps(pool);
        const offenderRecipient = 'rep-bouncer@e2e8.example';
        await seedProfile(pool, WS_REP, 'rep-1', offenderRecipient);
        // 60 messages_log sends → above MIN_SENT_FOR_RATE (50). One bounce → ~1.7%
        // bounce rate... that is BELOW 5%. To force a breach we record many bounce
        // events relative to sends. Use 60 sends and 4 hard bounces (≈6.7% > 5%).
        for (let i = 0; i < 60; i++) {
            await pool.query(`INSERT INTO messages_log (workspace_id, profile_id, ses_message_id, status)
         SELECT $1, id, $2, 'sent' FROM profiles WHERE workspace_id = $1 AND email = $3`, [WS_REP, nextSesId(), offenderRecipient]);
        }
        // Feed 4 distinct hard bounces through the REAL feedback core.
        let lastRes;
        for (let i = 0; i < 4; i++) {
            lastRes = await handleNotification(deps, {
                eventType: 'Bounce',
                bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: offenderRecipient }] },
                mail: { messageId: nextSesId(), tags: { workspace_id: [WS_REP] } },
            });
        }
        expect(lastRes?.status).toBe('ok');
        expect(lastRes?.status === 'ok' && lastRes.suspended).toBe(true);
        // Offender suspended; the active peer (WS_A) is untouched.
        expect(await statusOf(pool, WS_REP)).toBe('suspended');
        expect(await statusOf(pool, WS_A)).toBe('active');
        // And the suspended offender now REFUSES to send (gate), proving the suspend
        // closes the loop through the dispatcher.
        const ses = new CountingSes();
        const templateId = await seedTemplate(pool, WS_REP);
        const profileId = (await pool.query('SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2', [WS_REP, offenderRecipient])).rows[0].id;
        const outboxId = await enqueueOutbox(pool, WS_REP, profileId, templateId, 'rep-send-after-suspend');
        const res = await dispatchOutbox(dispatchDeps(pool, ses, new Date('2026-06-10T14:00:00Z')), outboxId);
        expect(res.result).toBe('refuse');
        expect(ses.sends).toHaveLength(0);
    });
});
//# sourceMappingURL=email-dispatch-pipeline.integration.test.js.map