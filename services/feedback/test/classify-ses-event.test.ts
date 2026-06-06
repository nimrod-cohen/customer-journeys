import { describe, it, expect } from 'vitest';
import { classifySesEvent } from '../src/core.js';

// §10 feedback pipeline — classify an SES notification into our internal event
// category. classifySesEvent reads BOTH shapes SES emits:
//   - legacy SNS "notificationType": Bounce|Complaint|Delivery
//   - Configuration-Set event publishing "eventType": Bounce|Complaint|Delivery|Open|Click
// Mapping:
//   Bounce/Permanent  -> hard_bounce
//   Bounce/Transient  -> soft_bounce
//   Complaint         -> complaint
//   Delivery/Open/Click -> other
// Recipients are lowercased; the SES message id is mail.messageId.

describe('classifySesEvent', () => {
  it('classifies a legacy permanent bounce as hard_bounce', () => {
    const r = classifySesEvent({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'A@Example.com' }] },
      mail: { messageId: 'ses-msg-1', source: 'no-reply@mail.acme.com' },
    });
    expect(r.category).toBe('hard_bounce');
    expect(r.sesMessageId).toBe('ses-msg-1');
    expect(r.recipients).toEqual(['a@example.com']);
  });

  it('classifies a legacy transient bounce as soft_bounce', () => {
    const r = classifySesEvent({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'soft@Example.com' }] },
      mail: { messageId: 'ses-msg-2' },
    });
    expect(r.category).toBe('soft_bounce');
    expect(r.recipients).toEqual(['soft@example.com']);
  });

  it('classifies a complaint', () => {
    const r = classifySesEvent({
      notificationType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: 'Mad@Example.com' }] },
      mail: { messageId: 'ses-msg-3' },
    });
    expect(r.category).toBe('complaint');
    expect(r.recipients).toEqual(['mad@example.com']);
  });

  it('classifies delivery/open/click as other', () => {
    expect(
      classifySesEvent({ notificationType: 'Delivery', mail: { messageId: 'm', destination: ['x@y.com'] } }).category,
    ).toBe('other');
    expect(classifySesEvent({ eventType: 'Open', mail: { messageId: 'm' } }).category).toBe('other');
    expect(classifySesEvent({ eventType: 'Click', mail: { messageId: 'm' } }).category).toBe('other');
  });

  it('reads the Configuration-Set eventType shape (Bounce/Permanent)', () => {
    const r = classifySesEvent({
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'cfg@Example.com' }] },
      mail: { messageId: 'cfg-1' },
    });
    expect(r.category).toBe('hard_bounce');
    expect(r.sesMessageId).toBe('cfg-1');
    expect(r.recipients).toEqual(['cfg@example.com']);
  });

  it('falls back to mail.destination recipients when no bounce/complaint list', () => {
    const r = classifySesEvent({
      notificationType: 'Delivery',
      mail: { messageId: 'd1', destination: ['One@Example.com', 'TWO@example.com'] },
    });
    expect(r.recipients).toEqual(['one@example.com', 'two@example.com']);
  });

  it('records the raw type label for storage', () => {
    expect(classifySesEvent({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent' }, mail: { messageId: 'm' } }).type).toBe('bounce');
    expect(classifySesEvent({ eventType: 'Complaint', mail: { messageId: 'm' } }).type).toBe('complaint');
    expect(classifySesEvent({ eventType: 'Open', mail: { messageId: 'm' } }).type).toBe('open');
    expect(classifySesEvent({ eventType: 'Click', mail: { messageId: 'm' } }).type).toBe('click');
    expect(classifySesEvent({ notificationType: 'Delivery', mail: { messageId: 'm' } }).type).toBe('delivery');
  });
});
