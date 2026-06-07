// Real /health probe (§16 "/health"). A pure, injected function so it can be
// unit-tested without the HTTP server: it pings the database and (optionally)
// probes the DLQ depths, returning an HTTP status + a structured body.
//
//   - DB ping fails        → 503 (the service cannot serve requests).
//   - any DLQ has depth > 0 → 503 degraded (operator attention required, §16).
//   - all green            → 200.
//
// The DLQ probe is OPTIONAL: when no `dlqDepths` dep is supplied the probe is
// skipped and health reflects DB connectivity only (local dev). All I/O is
// injected so the handler stays a thin wrapper.

/** Injected health dependencies — all I/O lives behind these. */
export interface HealthDeps {
  /** Ping the database (e.g. `SELECT 1`). Resolves on success, rejects on failure. */
  pingDb(): Promise<void>;
  /**
   * OPTIONAL: return the approximate message count of each monitored DLQ,
   * keyed by a human label. A depth > 0 marks the service degraded (§16).
   */
  dlqDepths?(): Promise<Record<string, number>>;
}

/** A single check's outcome. */
export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** The /health response: an HTTP status + a structured body. */
export interface HealthResult {
  readonly status: 200 | 503;
  readonly body: {
    readonly ok: boolean;
    readonly checks: CheckResult[];
  };
}

/**
 * Build the /health result by running the DB ping and (if provided) the DLQ
 * depth probe. Returns 200 only when every check passes; otherwise 503.
 * Never throws — a thrown ping/probe is captured as a failed check.
 */
export async function buildHealth(deps: HealthDeps): Promise<HealthResult> {
  const checks: CheckResult[] = [];

  // 1. Database connectivity (the hard gate).
  try {
    await deps.pingDb();
    checks.push({ name: 'database', ok: true });
  } catch (err) {
    checks.push({ name: 'database', ok: false, detail: (err as Error).message });
  }

  // 2. Optional DLQ-depth probe (degraded when any DLQ is non-empty).
  if (deps.dlqDepths) {
    try {
      const depths = await deps.dlqDepths();
      for (const [name, depth] of Object.entries(depths)) {
        checks.push({
          name: `dlq:${name}`,
          ok: depth === 0,
          ...(depth === 0 ? {} : { detail: `${depth} message(s) in DLQ` }),
        });
      }
    } catch (err) {
      checks.push({ name: 'dlq', ok: false, detail: (err as Error).message });
    }
  }

  const ok = checks.every((c) => c.ok);
  return { status: ok ? 200 : 503, body: { ok, checks } };
}
