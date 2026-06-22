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
