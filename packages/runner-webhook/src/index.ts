// @cdp/runner-webhook — the campaign webhook action's safety + execution core
// (§9B). Pure + injected: an SSRF/allowlist guard, a merge-rendering executor over
// an injected HTTP client, and a production fetch-based client behind the same
// interface. No DB/AWS — the runner wires this post-commit (mirrors enqueueSends).
export {
  assertWebhookTargetAllowed,
  isPrivateOrReservedHost,
  BlockedTargetError,
} from './ssrf.js';
export {
  executeWebhook,
  renderWebhookBody,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  type WebhookHttpClient,
  type WebhookRequest,
  type WebhookOutcome,
  type WebhookActionLike,
  type ExecuteWebhookOptions,
} from './execute.js';
export { fetchWebhookClient } from './client.js';
