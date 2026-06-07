// @cdp/service-image — presigned image upload (workspace-prefixed) + sharp
// variant generation + usage metering (§11, §20). Pure cores in ./key, ./presign,
// ./variants, ./usage; thin handlers in ./presign-handler, ./variant-handler;
// I/O wiring in ./deps.
export {
  buildImageKey,
  parseWorkspaceFromKey,
  assertKeyInWorkspace,
  KeyScopeError,
} from './key.js';
export {
  buildPresignRequest,
  isAllowedContentType,
  ContentTypeError,
  ALLOWED_CONTENT_TYPES,
  type AllowedContentType,
  type PresignRequestInput,
  type PutObjectInput,
} from './presign.js';
export {
  planVariants,
  VARIANT_WIDTHS,
  type VariantSpec,
  type SourceDimensions,
} from './variants.js';
export {
  buildImageBytesUpsert,
  monthBucket,
  IMAGE_STORAGE_BYTES,
  type SqlStatement,
} from './usage.js';
export {
  makePresignHandler,
  type PresignHandlerDeps,
  type PresignEvent,
  type GetSignedUrl,
  type HandlerResult,
} from './presign-handler.js';
export {
  makeVariantHandler,
  processUpload,
  type VariantHandlerDeps,
  type S3Event,
  type VariantOutcome,
} from './variant-handler.js';
export {
  loadImageConfig,
  makeS3Client,
  makePresignDeps,
  makeVariantDeps,
  type ImageConfig,
} from './deps.js';
export {
  saveTemplate,
  type SaveTemplateInput,
  type SaveTemplateResult,
  type RunStatement,
} from './save-template.js';

import { makePresignHandler, type PresignEvent } from './presign-handler.js';
import { makeVariantHandler, type S3Event } from './variant-handler.js';
import { makePresignDeps, makeVariantDeps } from './deps.js';

let presignCached: ReturnType<typeof makePresignHandler> | undefined;
let variantCached: ReturnType<typeof makeVariantHandler> | undefined;

/** Lambda entrypoint: presigned-URL minting (API Gateway). */
export async function presignHandler(event: PresignEvent) {
  if (!presignCached) presignCached = makePresignHandler(makePresignDeps());
  return presignCached(event);
}

/** Lambda entrypoint: S3-triggered variant generation + usage metering. */
export async function variantHandler(event: S3Event) {
  if (!variantCached) variantCached = makeVariantHandler(makeVariantDeps());
  return variantCached(event);
}
