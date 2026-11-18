/**
 * Bounce and complaint rates for the delivery-health dashboard.
 *
 * The denominator is what we SENT, not what was reported delivered. SES and
 * Resend report every delivery, but self-hosted SMTP reports only failures — so
 * "delivered" stays 0 there and bounced/(delivered+bounced) read 100% for a
 * single bounce. Taking the larger of sent and (delivered + bounced) gives the
 * same answer for SES (every send draws a report) and the true one for SMTP.
 * Complaints are measured against mail that got through: the larger of the
 * reported deliveries and sent minus bounced.
 */
export function deliveryRates(o: { sent: number; delivered: number; bounced: number; complained: number }): {
  bounce: number;
  complaint: number;
} {
  const attempts = Math.max(o.sent, o.delivered + o.bounced);
  const reached = Math.max(o.delivered, o.sent - o.bounced);
  return {
    bounce: attempts > 0 ? o.bounced / attempts : 0,
    complaint: reached > 0 ? o.complained / reached : 0,
  };
}
