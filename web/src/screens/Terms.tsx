// Public terms of service at /terms — readable WITHOUT logging in, like /privacy.
// The text is ours; its structure follows common SaaS marketing-platform terms.
import { LegalPage, Section, List, Intro, MailLink } from './LegalPage.js';

const UPDATED = 'November 19, 2026';
const mail = <MailLink />;
const privacy = (
  <a href="/privacy" class="font-semibold text-brand-700 hover:underline">
    Privacy Policy
  </a>
);

export function TermsOfService() {
  return (
    <LegalPage title="Terms of Service" updated={UPDATED} testid="terms-of-service">
      <Intro>
        <p>
          These terms (the “Agreement”) govern your use of Customer Journeys, the customer-data and
          messaging platform provided by OnGrow Journeys (“OnGrow”, “we”, “us”), including this
          website, the app and our APIs (together, the “Services”). By registering or using the
          Services you agree to them. If you use the Services for a company, you confirm you may
          bind that company, and “you” means the company.
        </p>
        <p>
          A signed order form or separate written agreement with us takes precedence over these
          terms where they conflict.
        </p>
      </Intro>

      <Section title="1. Using the Services">
        <p>
          Subject to this Agreement and payment of any fees, we give you a non-exclusive,
          non-transferable right to use the Services for your internal business purposes during your
          subscription. You may invite team members into your workspaces; you are responsible for
          what they do there.
        </p>
        <p>
          We continually improve the Services and may add, change or remove features. We will not
          materially reduce the core functionality of a paid plan during its current term.
        </p>
      </Section>

      <Section title="2. Your account">
        <p>
          You must give accurate registration information and keep it up to date. Keep your
          passwords, API keys and access tokens confidential, and tell us promptly at {mail} if you
          suspect unauthorized access. You are responsible for all activity under your account and
          keys.
        </p>
      </Section>

      <Section title="3. Your data">
        <p>
          You own the data you and your contacts put into the Services — profiles, events,
          templates, messages and everything else (“Customer Data”). You grant us a limited right to
          host, process and transmit it only as needed to provide, secure and support the Services
          and as the law requires.
        </p>
        <p>
          You are responsible for Customer Data: that you collected it lawfully, have every notice,
          consent and lawful basis required to upload it and to message the people in it, and that
          it does not infringe anyone’s rights. We process personal data in Customer Data as your
          processor, as described in our {privacy}.
        </p>
        <p>
          You can export or delete Customer Data while your account is active. After the Agreement
          ends we may delete it after a reasonable period.
        </p>
      </Section>

      <Section title="4. Acceptable use and messaging rules">
        <p>You agree not to, and not to let anyone else:</p>
        <List
          items={[
            'send messages to people who have not agreed to receive them, or use purchased, rented or scraped lists;',
            'ignore unsubscribes, opt-outs, bounces or complaints, or hide or remove the unsubscribe link from marketing messages;',
            'send messages that violate anti-spam, telemarketing or privacy laws, including the GDPR, CAN-SPAM, TCPA, Israel’s Communications Law (section 30A) and similar rules;',
            'send unlawful, deceptive, phishing, harassing or malicious content, or content that infringes others’ rights;',
            'upload sensitive data such as payment card numbers, government ID numbers or health records unless we have agreed to it in writing;',
            'copy, resell, sublicense or reverse engineer the Services, or use them to build a competing product;',
            'probe, bypass or break security measures, access another customer’s data, or overload or disrupt the Services;',
            'break the rules of a provider you connect (for example Meta’s WhatsApp Business policies or an email or SMS provider’s terms).',
          ]}
        />
        <p>
          Sending reputation is shared, so we watch bounce and complaint rates. We may pause
          sending, suspend a workspace or remove content that puts the Services, other customers or
          recipients at risk, and will tell you why when we reasonably can.
        </p>
      </Section>

      <Section title="5. Third-party services">
        <p>
          The Services let you connect providers such as email, SMS, WhatsApp and storage services.
          Those providers are not under our control: your relationship with them, including their
          fees, terms, approvals and availability, is between you and them. We are not responsible
          for their acts or outages.
        </p>
      </Section>

      <Section title="6. Fees and payment">
        <p>
          Paid plans are billed in advance, monthly or annually, as shown when you subscribe or in
          your order form. If your usage goes beyond your plan’s limits, we may charge for the extra
          usage or move you to the matching tier. Fees exclude taxes, which you are responsible for.
          Fees charged by providers you connect are separate and payable to them.
        </p>
        <p>
          Subscriptions renew automatically for the same period unless cancelled before the renewal
          date. We may change prices with at least 30 days’ notice, effective at your next renewal.
          Fees already paid are non-refundable except where the law or these terms say otherwise. We
          may suspend the Services if an invoice is more than 15 days overdue, after notice.
        </p>
      </Section>

      <Section title="7. Intellectual property and feedback">
        <p>
          We and our licensors own the Services, including the software, design and documentation.
          Nothing in this Agreement transfers those rights to you. If you send us suggestions or
          feedback, we may use them freely and without obligation to you.
        </p>
      </Section>

      <Section title="8. Confidentiality">
        <p>
          Each party will protect the other’s non-public information that is marked confidential or
          should reasonably be understood to be, using at least reasonable care, and use it only for
          this Agreement. This does not cover information that is public, already known,
          independently developed, or that must be disclosed by law (with notice where allowed).
        </p>
      </Section>

      <Section title="9. Privacy and security">
        <p>
          Our {privacy} explains how we handle personal information. We keep reasonable technical
          and organizational safeguards in place to protect Customer Data, and will notify you
          without undue delay if we become aware of a breach affecting it.
        </p>
      </Section>

      <Section title="10. Disclaimers">
        <p>
          The Services are provided “as is” and “as available”. To the extent the law allows, we
          disclaim all implied warranties, including merchantability, fitness for a particular
          purpose and non-infringement. We do not promise that the Services will be uninterrupted or
          error-free, or that any message will be delivered, opened or acted on — delivery depends
          on recipients’ providers and on factors outside our control.
        </p>
      </Section>

      <Section title="11. Indemnity">
        <p>
          You will defend and indemnify us against third-party claims, fines and costs arising from
          your Customer Data, the messages you send, or your breach of this Agreement or of
          applicable law.
        </p>
      </Section>

      <Section title="12. Limitation of liability">
        <p>
          To the extent the law allows, neither party is liable for indirect, incidental, special,
          consequential or punitive damages, or for lost profits, revenue or data. Our total
          liability arising from this Agreement is limited to the amount you paid us in the 12
          months before the claim arose, or USD 100 if greater. These limits do not apply to your
          payment obligations, your indemnity, your breach of section 4, or a party’s gross
          negligence or wilful misconduct.
        </p>
      </Section>

      <Section title="13. Term and termination">
        <p>
          This Agreement lasts as long as you use the Services. You may cancel at any time from
          within your account or by emailing {mail}; cancellation takes effect at the end of the
          current paid period, and fees for that period remain due. We may suspend or terminate the
          Services immediately if you materially breach this Agreement (including section 4), fail
          to pay, or become insolvent. Sections that by their nature should survive — such as fees
          owed, intellectual property, confidentiality, disclaimers, indemnity and limitation of
          liability — survive termination.
        </p>
      </Section>

      <Section title="14. Governing law">
        <p>
          This Agreement is governed by the laws of the State of Israel, without regard to its
          conflict-of-laws rules. The competent courts of Tel Aviv-Jaffa have exclusive jurisdiction
          over any dispute arising from it.
        </p>
      </Section>

      <Section title="15. General">
        <List
          items={[
            'Changes: we may update these terms. We will post the new version here and, for material changes, notify you by email or in the app at least 14 days before they take effect. Continuing to use the Services after that means you accept them.',
            'Force majeure: neither party is liable for delays caused by events beyond its reasonable control, such as natural disasters, war, internet or power failures, or failures of hosting and other upstream providers (payment obligations excepted).',
            'Assignment: you may not transfer this Agreement without our consent; we may transfer it in a merger, acquisition or sale of assets.',
            'Entire agreement: this Agreement, together with any order form and our Privacy Policy, is the whole agreement between us on its subject.',
            'Severability and waiver: if a provision is unenforceable, the rest stays in effect; not enforcing a right is not a waiver of it.',
            'No agency: the parties are independent contractors.',
          ]}
        />
      </Section>

      <Section title="16. Contact us">
        <p>Questions about these terms: {mail}.</p>
      </Section>
    </LegalPage>
  );
}
