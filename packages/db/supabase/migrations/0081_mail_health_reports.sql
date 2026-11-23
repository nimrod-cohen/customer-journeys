-- Results of the deliverability probe that runs on each of our mail servers. This is
-- PLATFORM data about our own IPs, so it has no workspace_id and only a platform
-- admin can read it. The app keeps the last 30 days.
CREATE TABLE IF NOT EXISTS mail_health_reports (
  id          bigserial PRIMARY KEY,
  ip          text NOT NULL,
  checked_at  timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  report      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_health_reports_ip_checked_idx ON mail_health_reports (ip, checked_at DESC);

ALTER TABLE mail_health_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON mail_health_reports;
CREATE POLICY platform_only ON mail_health_reports
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
