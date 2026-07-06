import { describe, it, expect } from 'vitest';
import { isPermanentSendError } from '../src/core.js';

// A PERMANENT provider rejection must be recorded as a visible failure (never
// retried); a TRANSIENT error is retried. This drives the dispatcher email catch.
describe('isPermanentSendError', () => {
  it('classifies SES hard rejections as PERMANENT', () => {
    expect(isPermanentSendError({ name: 'MessageRejected' })).toBe(true); // sandbox "not verified"
    expect(
      isPermanentSendError(Object.assign(new Error('Email address is not verified'), { name: 'MessageRejected' })),
    ).toBe(true);
    expect(isPermanentSendError({ name: 'MailFromDomainNotVerifiedException' })).toBe(true);
    expect(isPermanentSendError({ name: 'AccountSendingPausedException' })).toBe(true);
    expect(isPermanentSendError({ name: 'InvalidParameterValue' })).toBe(true);
    // A non-throttling 4xx is permanent even with an unknown name.
    expect(isPermanentSendError({ name: 'SomethingElse', $metadata: { httpStatusCode: 403 } })).toBe(true);
  });

  it('classifies transient errors as NOT permanent (retryable)', () => {
    expect(isPermanentSendError({ name: 'ThrottlingException', $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isPermanentSendError({ name: 'TooManyRequestsException' })).toBe(false);
    expect(isPermanentSendError({ name: 'InternalFailure', $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(isPermanentSendError(new Error('socket hang up'))).toBe(false);
    expect(isPermanentSendError(null)).toBe(false);
    expect(isPermanentSendError('boom')).toBe(false);
  });
});
