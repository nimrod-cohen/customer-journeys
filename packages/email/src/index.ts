// @cdp/email — SES client wrapper, MJML compile, List-Unsubscribe header
// builders, template-save plan, and the send-gate predicate.
// See CDP-BUILD-SPEC.md §9, §10, §10A, §11.

export { compileMjml, MjmlCompileError } from './mjml.js';

export {
  buildUnsubscribeUrl,
  buildListUnsubscribeHeaders,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  packSubscriptionToken,
  unpackSubscriptionToken,
  unsubscribeLinkSecret,
  DEV_UNSUBSCRIBE_LINK_SECRET,
  type UnsubscribeLinkParams,
  type ListUnsubscribeHeaders,
} from './unsubscribe.js';

export { buildTemplateUpsert, type SqlStatement } from './template.js';

export {
  canSend,
  type SendableWorkspace,
  type SendingIdentity,
} from './can-send.js';

export {
  ProdSesEmailClient,
  createSesClient,
  type SesClientConfig,
  type SesEmailClient,
  type CreateDomainIdentityResult,
  type IdentityVerificationAttributes,
  type DkimStatus,
  type SendEmailInput,
  type SendEmailResult,
} from './ses-client.js';

// Transactional (system) email — invites, password reset, verification. Separate
// from the per-company marketing pipeline; Resend provider + deterministic mock.
export {
  ResendMailer,
  MockTransactionalMailer,
  resolveTransactionalMailer,
  fetchTxHttpClient,
  TxSendError,
  DEFAULT_SYSTEM_FROM,
  type TransactionalMailer,
  type TxEmail,
  type TxSendResult,
  type TxHttpClient,
  type ResendConfig,
} from './transactional.js';

export {
  buildInviteEmail,
  buildPasswordResetEmail,
  type BuiltEmail,
} from './system-emails.js';

// Resend as an alternate per-company EMAIL transport (drop-in for the dispatcher's
// sendEmail). Chosen via a connector; From is the connector's trusted value.
export {
  createResendEmailClient,
  fetchResendHttpClient,
  type ResendEmailConfig,
  type ResendHttpClient,
  type ResendHttpResponse,
} from './resend-client.js';

// Self-hosted SMTP transport (drop-in for the dispatcher's sendEmail), plus the
// VERP bounce-token helpers that tie an inbound bounce back to the exact message.
export {
  createSmtpEmailClient,
  buildMimeMessage,
  type SmtpEmailConfig,
  type SmtpTransport,
  type SmtpEnvelope,
} from './smtp-client.js';
export {
  packVerpToken,
  unpackVerpToken,
  verpReturnPath,
  parseVerpRecipient,
  VERP_LOCAL_PART,
} from './verp.js';
export {
  makeSmtpTransport,
  smtpTransportFromEnv,
  type SmtpTransportConfig,
} from './smtp-transport.js';
