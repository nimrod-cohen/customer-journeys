// E2E (real Chromium): the system-admin Mail health screen shows who is blocking which
// server. The verdicts are unit-tested on the server, so the API answer is stubbed.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_ADMIN, DEV_MKT } from './seed.js';

const REPLY = '550 5.7.1 part of their network is on our block list (S3150).';
const health = {
  status: 'critical',
  generated_at: '2026-11-23T15:00:00.000Z',
  delivering_ip: '194.195.243.92',
  routes: [
    { provider: 'google', label: 'Google', via_ip: '194.195.243.92', planned_ip: '194.195.243.92', reason: null },
    { provider: 'microsoft', label: 'Microsoft', via_ip: '2.28.76.169', planned_ip: '2.28.76.169', reason: null },
  ],
  issues: [
    {
      severity: 'critical',
      title: 'Microsoft is blocking Linode (194.195.243.92)',
      detail: REPLY,
      help: 'https://olcsupport.office.com/',
    },
  ],
  servers: [
    {
      ip: '194.195.243.92',
      name: 'Linode',
      role: 'Relay',
      delivering: true,
      checked_at: '2026-11-23T14:30:00.000Z',
      stale: false,
      providers: [
        { provider: 'google', label: 'Google', status: 'ok', code: 250, block_code: null, reply: null },
        { provider: 'microsoft', label: 'Microsoft', status: 'blocked', code: 550, block_code: 'S3150', reply: REPLY },
        { provider: 'apple', label: 'Apple', status: 'ok', code: 250, block_code: null, reply: null },
      ],
      blocklists: [{ zone: 'zen.spamhaus.org', name: 'Spamhaus', status: 'clean', detail: null }],
    },
  ],
  rejections: [],
};

test('a system admin sees who is blocking which server', async ({ page }) => {
  await page.route('**/admin/mail-health', (route) => route.fulfill({ json: { health } }));
  await loginAs(page, DEV_ADMIN);

  await expect(page.getByTestId('nav-mail-health-badge')).toHaveText('1');
  await page.getByTestId('nav-mail-health').click();

  await expect(page.getByTestId('mail-health-status')).toHaveAttribute('data-status', 'critical');
  await expect(page.getByTestId('mail-health-issue')).toContainText('Microsoft is blocking Linode');
  const server = page.locator('[data-testid="mail-health-server"][data-ip="194.195.243.92"]');
  await expect(server).toContainText('Delivering mail now');
  const microsoft = server.locator('[data-provider="microsoft"]');
  await expect(microsoft).toContainText('Blocked');
  await expect(microsoft).toContainText('S3150');
  await expect(server.locator('[data-zone="zen.spamhaus.org"]')).toContainText('Not listed');
  await expect(page.locator('[data-testid="mail-health-route"][data-provider="google"]')).toContainText('Linode');
});

test('a marketer has no Mail health screen', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await expect(page.getByTestId('nav-mail-health')).toHaveCount(0);
});
