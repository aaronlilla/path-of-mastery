import type { Hash, PublishedRevisionRef, RevisionRef } from './stamp.js';

export type FailureCode = 'VALIDATION_FAILED' | 'UNSUPPORTED_VERSION' | 'LIMIT_EXCEEDED'
  | 'CYCLIC_PAYLOAD' | 'INVALID_LINK' | 'UNAVAILABLE' | 'REVISION_CONFLICT'
  | 'SIGN_IN_REQUIRED' | 'AI_ACCESS_REQUIRED' | 'ENTITLEMENT_UNAVAILABLE'
  | 'HUMAN_CHECK_REQUIRED' | 'CONNECTION_REVOKED' | 'AI_SERVICE_UNAVAILABLE'
  | 'RATE_LIMITED' | 'MODERATION_REJECTED'
  | 'FEATURE_PAUSED' | 'MAINTENANCE' | 'PROTECTED';
export type ApiFailure = { ok: false; code: FailureCode; message: string; retryAt?: string };

/** Every failure code, in declaration order. */
export const FAILURE_CODES: readonly FailureCode[] = Object.freeze(['VALIDATION_FAILED', 'UNSUPPORTED_VERSION', 'LIMIT_EXCEEDED',
  'CYCLIC_PAYLOAD', 'INVALID_LINK', 'UNAVAILABLE', 'REVISION_CONFLICT', 'SIGN_IN_REQUIRED', 'AI_ACCESS_REQUIRED', 'ENTITLEMENT_UNAVAILABLE',
  'HUMAN_CHECK_REQUIRED', 'CONNECTION_REVOKED', 'AI_SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'MODERATION_REJECTED',
  'FEATURE_PAUSED', 'MAINTENANCE', 'PROTECTED'] as const);

/**
 * HTTP status per failure code. The first fifteen agree with the site's statusFor(). The rest:
 * FEATURE_PAUSED (a flag is off; message = the flag message) and MAINTENANCE (retryAt = maintenance.until) answer 503;
 * PROTECTED (an admin tried to switch off something that protects the user's data or exit) answers 403.
 */
export const FAILURE_HTTP_STATUS: Readonly<Record<FailureCode, number>> = Object.freeze({
  VALIDATION_FAILED: 400, UNSUPPORTED_VERSION: 400, LIMIT_EXCEEDED: 413, CYCLIC_PAYLOAD: 400, INVALID_LINK: 400, UNAVAILABLE: 404,
  REVISION_CONFLICT: 409, SIGN_IN_REQUIRED: 401, AI_ACCESS_REQUIRED: 403, ENTITLEMENT_UNAVAILABLE: 503, HUMAN_CHECK_REQUIRED: 403,
  CONNECTION_REVOKED: 403, AI_SERVICE_UNAVAILABLE: 503, RATE_LIMITED: 429, MODERATION_REJECTED: 400,
  FEATURE_PAUSED: 503, MAINTENANCE: 503, PROTECTED: 403,
});

/** Default user-facing text for the admin-ops codes. */
export const FEATURE_PAUSED_MESSAGE = 'This feature is paused. Your work is saved.';
export const MAINTENANCE_MESSAGE = 'Down for maintenance. Your work is saved.';
export const PROTECTED_MESSAGE = 'This cannot be switched off.';
export type ApiResult<T> = { ok: true; value: T } | ApiFailure;
export type EntitlementDecision =
  | { status: 'authorized'; authorizationId: string; expiresAt: string; requestHash: Hash; scopes: string[] }
  | { status: 'denied'; code: 'SIGN_IN_REQUIRED' | 'AI_ACCESS_REQUIRED' | 'ENTITLEMENT_UNAVAILABLE' | 'HUMAN_CHECK_REQUIRED' | 'CONNECTION_REVOKED' | 'AI_SERVICE_UNAVAILABLE' };
export type NetworkClearance =
  | { status: 'clear'; clearanceId: string; expiresAt: string; requestHash: Hash }
  | { status: 'human_check_required'; challengeId: string; expiresAt: string; requestHash: Hash }
  | { status: 'unavailable'; retryAt: string | null };
export type PendingIntent = {
  schemaVersion: 1;
  requestId: string;
  idempotencyKey: string;
  accountBinding: string;
  target: RevisionRef | PublishedRevisionRef;
  requestHash: Hash;
  operation: 'read' | 'vote' | 'save' | 'publish' | 'report' | 'feedback' | 'checkout' | 'external_edit';
  resumePolicy: 'once' | 'return_to_review';
};
export type AiAuthorizationRequest = { requestId: string; requestHash: Hash; target: RevisionRef; scope: string; clientId: string | null };
export type PairedClient = { clientId: string; scopes: string[]; status: 'paired' | 'revoked'; expiresAt: string };
