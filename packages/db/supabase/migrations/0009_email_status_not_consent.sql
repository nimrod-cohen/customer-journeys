-- 0009_email_status_not_consent.sql
-- email_status is the address DELIVERABILITY state (active | bounced | complained)
-- reported by the provider — NOT consent. Unsubscribe is the separate boolean
-- attribute `unsubscribed` (set by the §10 unsubscribe flow + suppression).
-- Reconcile any profile that was mis-modelled with email_status='unsubscribed':
-- move that signal to the attribute and reset deliverability to active (the
-- mailbox itself is fine — the person just opted out).
UPDATE profiles
   SET attributes = attributes || '{"unsubscribed": true}'::jsonb,
       email_status = 'active',
       updated_at = now()
 WHERE email_status = 'unsubscribed';
