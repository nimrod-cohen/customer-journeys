// Lambda entrypoint for the unsubscribe service (§10). Wires production deps
// into the thin HTTP handler. Pure logic lives in ./core.ts; all I/O in ./deps.ts.
import { makeUnsubscribeHandler, type UnsubscribeHttpEvent } from './handler.js';
import { makeProdDeps } from './deps.js';

export {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
  buildUnsubscribeActivity,
  buildUnsubscribeEvent,
  type SqlStatement,
  type UnsubscribeRequest,
  type ParsedUnsubscribe,
  type InvalidUnsubscribe,
} from './core.js';
export {
  makeUnsubscribeHandler,
  confirmPage,
  donePage,
  acceptLanguageFromEvent,
  simpleUnsubscribeStatements,
  type UnsubscribeHttpEvent,
  type UnsubscribeHttpResponse,
  type UnsubscribeDeps,
} from './handler.js';
export { makeProdDeps, runUnsubscribeInWorkspaceTx, type PoolLike } from './deps.js';
export {
  makePreferenceCenterHandler,
  readTopicsEnabled,
  readFrontFacingLanguage,
  type PreferenceCenterDeps,
  type PreferenceReader,
} from './preference-handler.js';
export {
  resolveLanguage,
  acceptLanguagePrefersHebrew,
  isFrontFacingLanguage,
  normalizeFrontFacingLanguage,
  dirFor,
  stringsFor,
  FRONT_FACING_LANGUAGES,
  DEFAULT_FRONT_FACING_LANGUAGE,
  type FrontFacingLanguageSetting,
  type Lang,
  type Strings,
} from './i18n.js';
export { resolveCompanyLogoAssetId, logoImgTag, renderCompanyLogo } from './logo.js';
export {
  parsePreferenceUpdate,
  buildActiveTopicsQuery,
  buildTopicStateQuery,
  buildGroupStateQuery,
  buildTopicSubscriptionUpsert,
  buildChannelOptOutWrite,
  buildOptOutAllTopics,
  toTopicChoices,
  isMediumGroup,
  MEDIUM_GROUPS,
  type MediumGroup,
  type TopicChoice,
  type PreferenceUpdate,
} from './preference-center.js';

let cached: ReturnType<typeof makeUnsubscribeHandler> | undefined;

/**
 * Production Lambda entry. The API Gateway event carries `headers` — we forward
 * the `Accept-Language` header onto the synthetic event so a workspace with
 * front_facing_language='auto' renders in the recipient's browser language
 * (`acceptLanguageFromEvent` reads it case-insensitively).
 */
export async function handler(
  event: UnsubscribeHttpEvent & { headers?: Record<string, string | undefined> | null },
) {
  if (!cached) cached = makeUnsubscribeHandler(makeProdDeps());
  const acceptLanguage = event.headers
    ? Object.entries(event.headers).find(([k]) => k.toLowerCase() === 'accept-language')?.[1] ?? null
    : null;
  return cached({ ...event, acceptLanguage });
}
