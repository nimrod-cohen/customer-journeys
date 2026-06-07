/** The minimal SQS surface the core needs (mockable). */
export interface SqsLike {
    send(command: unknown): Promise<unknown>;
}
/** Injected dependencies for `replayDlq`. */
export interface ReplayDeps {
    readonly sqs: SqsLike;
    /** The DLQ to drain FROM. */
    readonly dlqUrl: string;
    /** The source FIFO queue to replay INTO. */
    readonly sourceUrl: string;
    /** Receive nothing/send nothing/delete nothing — just report (default false). */
    readonly dryRun?: boolean;
    /** Stop after this many messages (default: drain until empty). */
    readonly maxMessages?: number;
    /** Per-receive batch size, 1–10 (default 10). */
    readonly batchSize?: number;
}
/** The outcome of one replay run. */
export interface ReplayResult {
    readonly received: number;
    readonly replayed: number;
    readonly deleted: number;
    readonly dryRun: boolean;
    /** Set when the run stopped early because a send failed (message left intact). */
    readonly stoppedOnError?: string;
}
/**
 * Replay messages from a FIFO DLQ back to its source FIFO queue, preserving
 * MessageGroupId + MessageDeduplicationId, deleting from the DLQ only after a
 * successful re-send. Returns counts; never throws on a per-message send failure
 * (it stops and reports, leaving the offending message intact on the DLQ).
 */
export declare function replayDlq(deps: ReplayDeps): Promise<ReplayResult>;
//# sourceMappingURL=dlq-replay.d.ts.map