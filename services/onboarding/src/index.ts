// @cdp/service-onboarding — guided domain-onboarding wizard backend (§10A).
// Entrypoints (start-domain / check-domain / activate) wire injected SES + DNS +
// SES-status readers to the pure cores in ./core.ts. Logic lives in the cores;
// handlers/entrypoints stay thin. See CDP-BUILD-SPEC.md §10, §10A.

export {
  buildDnsRecordSet,
  diffRecord,
  checkDomainCore,
  activateDecision,
  buildStartDomainUpdate,
  buildActivateUpdate,
  type SqlStatement,
  type DnsRecord,
  type DnsRecordSet,
  type DnsRecordType,
  type DnsAnswer,
  type RecordCheck,
  type RecordStatus,
  type RecordRole,
  type CheckDomainResult,
  type ActivateDecision,
} from './core.js';

export {
  startDomain,
  type StartDomainDeps,
  type StartDomainInput,
  type StartDomainOutput,
} from './start-domain.js';

export {
  checkDomain,
  resolveAnswers,
  recordSetFromIdentity,
  type CheckDomainDeps,
  type CheckDomainInput,
  type DnsResolver,
  type SendingIdentityReader,
  type PersistedSendingIdentity,
} from './check-domain.js';

export {
  activate,
  type ActivateDeps,
  type ActivateInput,
  type ActivateOutput,
} from './activate.js';

export {
  makeProdDeps,
  makeWorkspaceTxRunner,
  makeProdDnsResolver,
  makeSendingIdentityReader,
  configSetNameFor,
  type ProdOnboardingDeps,
} from './deps.js';
