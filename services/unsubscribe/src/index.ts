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
  type UnsubscribeHttpEvent,
  type UnsubscribeHttpResponse,
  type UnsubscribeDeps,
} from './handler.js';
export { makeProdDeps, runUnsubscribeInWorkspaceTx, type PoolLike } from './deps.js';
export {
  makePreferenceCenterHandler,
  type PreferenceCenterDeps,
  type PreferenceReader,
} from './preference-handler.js';
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

export async function handler(event: UnsubscribeHttpEvent) {
  if (!cached) cached = makeUnsubscribeHandler(makeProdDeps());
  return cached(event);
}
