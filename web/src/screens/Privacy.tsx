// Public privacy policy at /privacy — readable WITHOUT logging in, like /docs.
// Rendered by App before its auth gate; the server serves the SPA shell at that path.
// The text is ours; its structure follows common SaaS marketing-platform policies
// (controller for our own users vs processor for our customers' contacts).
import { LegalPage, Section, List, Intro, MailLink } from './LegalPage.js';

const UPDATED = 'November 19, 2026';
const mail = <MailLink />;

export function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" updated={UPDATED} testid="privacy-policy">
      <Intro>
        <p>
          This policy explains what personal information OnGrow Journeys (“OnGrow”, “we”, “us”)
          collects, why, and what choices you have. It covers two different situations:
        </p>
        <List
          items={[
            <>
              <strong>Our own users and visitors.</strong> When you visit this site, register, or
              use the app as a customer, we decide how your information is used. Here we act as the{' '}
              <em>controller</em>.
            </>,
            <>
              <strong>Our customers’ contacts.</strong> Businesses use Customer Journeys to store
              profiles of their own customers and send them email, SMS and WhatsApp messages. For
              that data we act only as a <em>processor</em> on the business’s behalf and follow its
              instructions. If you received a message from one of our customers, their privacy
              policy governs how they use your information, and requests about it should go to them
              first.
            </>,
          ]}
        />
        <p>
          For customers, this policy forms part of your agreement with us. It does not cover our
          employees or job applicants.
        </p>
      </Intro>

      <Section title="1. Information we collect">
        <p>
          <strong>Account information.</strong> Name, email address, password (stored only as a
          secure hash), company and workspace names, your role, and the settings you choose.
        </p>
        <p>
          <strong>Configuration and credentials.</strong> Sending domains, sender names, and the
          provider credentials you connect (such as email, SMS, WhatsApp or storage keys). Secrets
          are encrypted at rest and never shown back in the app.
        </p>
        <p>
          <strong>Customer data.</strong> Information our customers upload or send to the service
          about their own contacts: identifiers like email address and phone number, profile
          attributes, behavioral events, segment membership, message content, subscription
          preferences, and inbound WhatsApp messages and media.
        </p>
        <p>
          <strong>Message activity.</strong> Delivery, bounce and complaint reports from mail and
          messaging providers, and — where a customer turns tracking on — whether a recipient opened
          an email or clicked a link, along with the time, IP address and device/browser type of
          that request.
        </p>
        <p>
          <strong>Usage and technical data.</strong> Log data such as IP address, browser and device
          type, pages visited and error reports, used to operate and secure the service. Billing and
          usage metering records for each workspace.
        </p>
        <p>
          <strong>Communications.</strong> What you send us when you contact support or otherwise
          correspond with us.
        </p>
        <p>
          We ask customers not to upload sensitive categories of data (for example health, financial
          account or government ID numbers). We do not intentionally collect such data for our own
          purposes.
        </p>
      </Section>

      <Section title="2. How we collect it">
        <List
          items={[
            'Directly from you, when you register, configure the app or contact us.',
            'From our customers, through the app, CSV imports and our APIs.',
            'From messaging providers, through delivery reports and inbound-message webhooks.',
            'Automatically, through server logs and, where enabled by a customer, open and click tracking in messages.',
          ]}
        />
      </Section>

      <Section title="3. How we use it">
        <List
          items={[
            'To provide, operate and maintain the service, including sending messages on our customers’ instructions.',
            'To authenticate users, keep workspaces isolated from each other, and protect against fraud, spam and abuse.',
            'To honor unsubscribes, bounces and complaints so that people who opted out are not contacted again.',
            'To measure usage, bill customers and report each workspace’s costs.',
            'To provide support, send service and security notices, and tell you about changes to our terms.',
            'To understand and improve the service, using aggregated or de-identified information where possible.',
            'To comply with legal obligations and enforce our agreements.',
          ]}
        />
        <p>
          We use customer data only to provide the service to that customer. We do not sell personal
          information, and we do not use our customers’ contact data to market our own products.
        </p>
      </Section>

      <Section title="4. Legal bases (EEA, UK and Switzerland)">
        <p>
          Where we act as controller we rely on: performing our contract with you; our legitimate
          interests in running, securing and improving the service, where those interests are not
          outweighed by your rights; your consent, where we ask for it; and compliance with legal
          obligations. For customer data, the customer is responsible for having a lawful basis and
          giving any notices or obtaining any consents its contacts require.
        </p>
      </Section>

      <Section title="5. How we share it">
        <p>We share personal information only as follows:</p>
        <List
          items={[
            <>
              <strong>With the customer it belongs to.</strong> Data about a customer’s contacts,
              including message activity, is available to that customer.
            </>,
            <>
              <strong>With service providers (sub-processors)</strong> that host and run the service
              for us — for example cloud hosting and database providers, object storage, and email
              delivery infrastructure — under contracts that limit their use of the data to
              providing services to us.
            </>,
            <>
              <strong>With providers a customer connects.</strong> When a customer connects its own
              email, SMS or WhatsApp provider, we pass recipient details and message content to that
              provider at the customer’s direction. Those providers act under their own terms with
              the customer.
            </>,
            <>
              <strong>For legal reasons</strong> — when required by law, subpoena or other legal
              process, or when necessary to protect the rights, property or safety of us, our
              customers or others.
            </>,
            <>
              <strong>In a business transfer</strong>, such as a merger, acquisition or sale of
              assets, subject to this policy.
            </>,
          ]}
        />
      </Section>

      <Section title="6. International transfers">
        <p>
          We and our providers may process information in countries other than yours, including
          Israel, the European Union and the United States. Where the law requires it, we use
          appropriate safeguards for such transfers, such as the European Commission’s Standard
          Contractual Clauses.
        </p>
      </Section>

      <Section title="7. Security">
        <p>
          We use technical and organizational measures to protect information, including encryption
          in transit, encryption of stored credentials, per-workspace data isolation, role-based
          access and logging of administrative access. No system is perfectly secure, so we cannot
          guarantee absolute security, and we will notify affected customers of a personal-data
          breach as the law requires.
        </p>
      </Section>

      <Section title="8. Retention">
        <p>
          We keep account information while your account is active and for a reasonable time
          afterwards to meet legal, tax and accounting requirements and resolve disputes. Customer
          data is kept for as long as the customer keeps it in the service; customers can delete
          individual profiles (which erases their related events and messages) at any time. When a
          customer’s agreement ends, we delete or return its data within a reasonable period, unless
          the law requires us to keep it. Suppression records may be kept longer so that people who
          opted out stay opted out.
        </p>
      </Section>

      <Section title="9. Your rights and choices">
        <p>
          Depending on where you live (for example under the GDPR, UK GDPR, the Israeli Privacy
          Protection Law or US state laws such as the CCPA), you may have the right to:
        </p>
        <List
          items={[
            'access the personal information we hold about you and receive a copy of it;',
            'correct inaccurate or incomplete information;',
            'have your information deleted;',
            'object to or restrict certain processing, including direct marketing;',
            'withdraw consent where we rely on it;',
            'not be discriminated against for exercising these rights;',
            'complain to your local data protection authority.',
          ]}
        />
        <p>
          Every marketing message sent through the service includes a link to unsubscribe or manage
          your preferences. To exercise your rights, email {mail}. We may need to verify your
          identity before acting on a request. If your request concerns data we process for one of
          our customers, we will refer you to that customer and help them respond. We aim to respond
          within 30 days, or within the time the law allows.
        </p>
      </Section>

      <Section title="10. Cookies">
        <p>
          The app uses only what it needs to work: your browser’s local storage keeps your sign-in
          session and display preferences (such as theme, text size and table columns). We do not
          use advertising cookies. Tracking pixels and redirect links appear only in messages from
          customers who enabled open and click tracking.
        </p>
      </Section>

      <Section title="11. Children">
        <p>
          The service is meant for businesses and is not directed to children under 16. We do not
          knowingly collect their information; if we learn we have, we will delete it.
        </p>
      </Section>

      <Section title="12. Changes to this policy">
        <p>
          We may update this policy from time to time. We will post the new version here with a new
          “last updated” date and, for material changes, notify customers by email or in the app.
        </p>
      </Section>

      <Section title="13. Contact us">
        <p>Questions about this policy or our privacy practices: {mail}.</p>
      </Section>
    </LegalPage>
  );
}
