-- 0008_unsubscribed_attribute.sql
-- Make `unsubscribed` a first-class boolean PROFILE ATTRIBUTE so marketers can
-- segment on "unsubscribed = true / = false". The §10 unsubscribe flow now also
-- sets attributes.unsubscribed = true (alongside the suppression, which remains
-- the authoritative send gate). Here we:
--   (a) default the attributes column so a profile created with no explicit
--       attributes starts subscribed (unsubscribed=false), and
--   (b) backfill existing profiles that lack the key to false — so "= false"
--       matches everyone currently subscribed.
ALTER TABLE profiles ALTER COLUMN attributes SET DEFAULT '{"unsubscribed": false}'::jsonb;

UPDATE profiles
   SET attributes = '{"unsubscribed": false}'::jsonb || attributes
 WHERE NOT (attributes ? 'unsubscribed');
