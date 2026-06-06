// Ingest Lambda — resolves workspace_id from the API key (never the payload),
// upserts the profile, and enqueues onto SQS FIFO (MessageGroupId=profile_id).
// Returns 200 only after SQS accepts (durable boundary). See §7.
//
// Scaffolding only: thin handler shell. Pure logic implemented test-first in §3.
export {};
