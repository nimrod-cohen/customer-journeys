// What changed in each release, in plain language for the people who use the app
// (marketers and owners), NEWEST FIRST. Rendered by screens/Changelog.tsx.
//
// Every version bump adds its entry here (CLAUDE.md, Standing conventions) — the
// deployed build has no git history, so this file IS the changelog. A test checks
// that the top entry matches the root package.json version.
//
// Write for a marketer, not a developer: what they can now do, or what stopped going
// wrong. Releases with nothing a user would notice (tests, docs, internal clean-up)
// may be left out.

export interface ChangelogEntry {
  version: string;
  /** YYYY-MM-DD. Omitted for a few early releases whose dates weren't recorded. */
  date?: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.167.0',
    date: '2026-11-23',
    changes: [
      'If Google, Microsoft or Apple blocks one of our mail servers, their mail now moves automatically to a healthy server. The Mail health screen shows which server carries each provider.',
    ],
  },
  {
    version: '0.166.0',
    date: '2026-11-23',
    changes: [
      'System admins get a new Mail health screen showing whether Google, Microsoft, Apple or Spamhaus are blocking our mail servers, with a warning badge in the menu.',
      'When a mail provider blocks our sending server, recipients are no longer marked as bounced, so valid addresses keep receiving your email once the block clears.',
    ],
  },
  {
    version: '0.165.1',
    date: '2026-11-20',
    changes: [
      'Email attachments with Hebrew or other non-English file names now keep their name in Gmail instead of showing underscores.',
    ],
  },
  {
    version: '0.165.0',
    date: '2026-11-19',
    changes: ['There are now public terms of service at /terms, linked from the sign-in page.'],
  },
  {
    version: '0.164.0',
    date: '2026-11-19',
    changes: ['There is now a public privacy policy at /privacy, linked from the sign-in page.'],
  },
  {
    version: '0.163.2',
    date: '2026-11-18',
    changes: [
      'In an automation, an email step that had been duplicated before steps got their own email copies now opens its own email. It used to open the other step’s email the first time, so your changes landed in the wrong email.',
    ],
  },
  {
    version: '0.163.1',
    date: '2026-11-18',
    changes: [
      'You can now actually type a decimal like 1.4 into the line height fields; the value applies when you leave the field or press Enter. (Typing 1.4 used to turn into 3.)',
    ],
  },
  {
    version: '0.163.0',
    date: '2026-11-18',
    changes: [
      'Set the space between paragraphs for a whole email under Template → Paragraph spacing (in px). The editor now also shows paragraphs spaced the way they arrive in the inbox.',
    ],
  },
  {
    version: '0.162.1',
    date: '2026-11-18',
    changes: [
      'Line height fields in the email editor now take decimals like 1.4 (or 1,4), both for the whole email and for a single text block.',
    ],
  },
  {
    version: '0.162.0',
    date: '2026-11-18',
    changes: [
      'Set the line height for a whole email under Template in the email editor (e.g. 1.5). Every text block follows it unless you give a block its own line height.',
    ],
  },
  {
    version: '0.161.1',
    date: '2026-11-18',
    changes: [
      'Clearing all the text from a block in the email editor now shows a notice with an Undo button, so a whole message body can no longer disappear unnoticed.',
      'The unsubscribe link in a test email is now the tested customer’s own link, so you see exactly where theirs leads. Opening it changes nothing; submitting the page would update that customer.',
    ],
  },
  {
    version: '0.161.0',
    date: '2026-11-18',
    changes: [
      'Merge tags can now run code: write {{ return … }} in any email subject, body, SMS or WhatsApp message, e.g. {{ return customer.first_name ? customer.first_name + ", " : "" }} to add a name and comma only when there is a name. See Help → Personalization tokens.',
    ],
  },
  {
    version: '0.160.1',
    date: '2026-11-18',
    changes: [
      'The unsubscribe link in a test email now works: it opens your own subscription page (never the customer’s), so you can check the link without affecting them.',
    ],
  },
  {
    version: '0.160.0',
    date: '2026-11-18',
    changes: [
      'Automations with a manual trigger now have an “Enroll…” button: start the journey for one customer or for everyone currently in a segment. You can also enroll a customer from their profile (⋮ → Enroll in automation…). People already in the automation are never enrolled twice, and you are told how many were new.',
    ],
  },
  {
    version: '0.159.0',
    date: '2026-11-18',
    changes: [
      'Send yourself a test of any automation email, SMS or WhatsApp step: pick one of the last 10 customers the automation would have enrolled (the latest to fire its event, enter its segment, and so on) and the message is filled in with their real details. It is marked [TEST], goes only to you, and the customer receives nothing and is not enrolled.',
    ],
  },
  {
    version: '0.158.1',
    date: '2026-11-18',
    changes: [
      'Publishing an automation you never named now gives it the name you type in the publish dialog, instead of leaving it as "Untitled automation".',
    ],
  },
  {
    version: '0.158.0',
    date: '2026-11-18',
    changes: [
      'Email sent through the internal mail server now shows as Delivered, on the delivery-health dashboard, the broadcast funnel and each profile, including the last 30 days of past sends.',
    ],
  },
  {
    version: '0.157.3',
    date: '2026-11-18',
    changes: [
      'Delivery health: the bounce rate is now measured against everything you sent, so one bounce no longer shows as 100% when your mail server only reports failures.',
    ],
  },
  {
    version: '0.157.2',
    date: '2026-11-18',
    changes: [
      'Automation builder: the canvas now fits the screen, so you no longer scroll the page to see all of it.',
      'Panning stops at the edge of the journey: the last step always stays in view, whether you drag, scroll or use the mini-map.',
    ],
  },
  {
    version: '0.157.1',
    date: '2026-11-18',
    changes: ['Behind-the-scenes update; nothing changes in how you use the app.'],
  },
  {
    version: '0.157.0',
    date: '2026-11-18',
    changes: ['New: this “What’s new” page. Click the version number at the bottom of the sidebar to open it.'],
  },
  {
    version: '0.156.0',
    date: '2026-11-18',
    changes: [
      'Automation builder: steps sit closer together, so more of the journey fits on screen.',
      'A mini-map in the corner shows the whole journey; click or drag it to jump around.',
    ],
  },
  {
    version: '0.155.2',
    date: '2026-11-17',
    changes: ['The email editor keeps your last 50 changes in its history.'],
  },
  {
    version: '0.155.1',
    date: '2026-11-17',
    changes: [
      'The email editor’s history and undo now survive closing the email — reopen it and you can still step back.',
      'Duplicating an email step in an automation gives the copy its own email, so editing one no longer changes the other.',
    ],
  },
  {
    version: '0.155.0',
    date: '2026-11-17',
    changes: ['Automations can wait until a time of day — for example “tomorrow at 09:00” in your workspace’s timezone.'],
  },
  {
    version: '0.154.0',
    date: '2026-11-17',
    changes: [
      'Someone who unsubscribes from everything now leaves every automation they’re in, automatically.',
      'An exit rule can watch several event types at once.',
    ],
  },
  {
    version: '0.153.0',
    date: '2026-11-17',
    changes: ['Exit rules you aren’t editing fold into a one-line summary, so the list stays short.'],
  },
  {
    version: '0.152.3',
    date: '2026-11-16',
    changes: ['Renaming a draft automation now saves reliably.'],
  },
  {
    version: '0.152.2',
    date: '2026-11-16',
    changes: ['A draft automation is labelled “not published yet” instead of “unsaved”.'],
  },
  {
    version: '0.152.1',
    date: '2026-11-16',
    changes: ['In the email editor, a row’s ⋮ menu offers Save as component, Edit and Unlink.'],
  },
  {
    version: '0.152.0',
    date: '2026-11-16',
    changes: [
      'Saved email components: build a footer or header once and reuse it in many emails.',
      'Editing a component updates every email that uses it — including scheduled broadcasts and automations. Unlink it to make a one-off change.',
    ],
  },
  {
    version: '0.151.1',
    date: '2026-11-16',
    changes: [
      'Text pasted into the email editor keeps its words and basic formatting but drops the source’s layout.',
      'The structure menu shows correctly inside the editor.',
    ],
  },
  {
    version: '0.151.0',
    date: '2026-11-16',
    changes: ['Automations have a Settings tab for exit rules; Save draft and Publish sit above the canvas.'],
  },
  {
    version: '0.150.1',
    date: '2026-11-16',
    changes: ['You can reach an automation’s exit rules from its trigger.'],
  },
  {
    version: '0.150.0',
    date: '2026-11-16',
    changes: [
      'AI access: connect an AI assistant to your workspace (Workspace settings → AI access).',
      'It can read and draft automations, broadcasts, segments and messages, but can never publish or send anything.',
    ],
  },
  {
    version: '0.149.0',
    date: '2026-11-16',
    changes: ['Exit rules: take someone out of an automation, or restart it for them, when something happens mid-journey.'],
  },
  {
    version: '0.148.0',
    date: '2026-11-16',
    changes: ['In the activity log, a bounce links to the person, explains why it failed and shows the email’s subject.'],
  },
  {
    version: '0.147.0',
    date: '2026-11-04',
    changes: ['When merging two profiles, choose which email and phone the merged profile keeps.'],
  },
  {
    version: '0.146.0',
    date: '2026-11-04',
    changes: ['The merge drawer has a searchable profile picker.'],
  },
  {
    version: '0.145.0',
    date: '2026-11-01',
    changes: ['Segments and automations can have an optional description.'],
  },
  {
    version: '0.144.0',
    date: '2026-10-29',
    changes: ['Duplicate an email template from the library.'],
  },
  {
    version: '0.143.0',
    date: '2026-10-27',
    changes: ['Text size is now a slider, and the default is a bit larger.'],
  },
  {
    version: '0.142.0',
    date: '2026-10-26',
    changes: ['Change the text size and switch between light and dark themes from the bottom of the sidebar.'],
  },
  {
    version: '0.141.0',
    date: '2026-10-24',
    changes: ['In a WhatsApp chat, a template message shows the text the customer actually received, with a flip to its details.'],
  },
  {
    version: '0.140.4',
    date: '2026-10-21',
    changes: ['The WhatsApp send button locks while a message is sending, so it can’t go twice.'],
  },
  {
    version: '0.140.3',
    date: '2026-10-21',
    changes: ['Your browser no longer autofills your password into provider credential forms.'],
  },
  {
    version: '0.140.0',
    date: '2026-10-19',
    changes: [
      'WhatsApp inbox: read and answer WhatsApp chats in one place, or from a person’s profile.',
      'Free replies within 24 hours of their last message; after that, an approved template.',
    ],
  },
  {
    version: '0.139.0',
    date: '2026-10-19',
    changes: [
      'Incoming WhatsApp messages and delivery statuses are now recorded.',
      'A reply counts as an event, so segments and automations can react to it.',
    ],
  },
  {
    version: '0.138.0',
    date: '2026-10-19',
    changes: ['Each workspace connects its own WhatsApp number (Workspace settings → WhatsApp).'],
  },
  {
    version: '0.137.2',
    date: '2026-10-19',
    changes: ['Fixed: email steps in automations were skipped for companies using our own mail server.'],
  },
  {
    version: '0.137.1',
    date: '2026-10-11',
    changes: ['Fixed: some long emails failed their signature check and could land in spam.'],
  },
  {
    version: '0.137.0',
    date: '2026-10-11',
    changes: ['Fixed: broadcasts sent through our own mail server weren’t going out, without any warning.'],
  },
  {
    version: '0.136.0',
    date: '2026-10-08',
    changes: ['Emails keep their line breaks and images, and include a plain-text version, which helps them avoid spam folders.'],
  },
  {
    version: '0.135.0',
    date: '2026-10-08',
    changes: ['Transactional messages can carry real meeting invites, with Accept and Decline buttons.'],
  },
  {
    version: '0.134.0',
    date: '2026-10-04',
    changes: ['The profiles list has a “Last event” column.'],
  },
  {
    version: '0.133.0',
    date: '2026-09-30',
    changes: ['A person’s Delivery tab lists every message actually sent to them, not just the bounces.'],
  },
  {
    version: '0.132.0',
    date: '2026-09-30',
    changes: ['A sending domain can keep the signing key it already publishes.'],
  },
  {
    version: '0.131.1',
    date: '2026-09-30',
    changes: ['Domain setup says “replace the value” when a DNS record exists but is wrong.'],
  },
  {
    version: '0.131.0',
    date: '2026-09-30',
    changes: ['Platform admins can add users and workspaces to a company that has none yet.'],
  },
  {
    version: '0.130.0',
    date: '2026-09-30',
    changes: ['A message with no delivery report is no longer described as missing — no news is usually good news.'],
  },
  {
    version: '0.129.0',
    date: '2026-09-29',
    changes: ['Image storage has a Test connection button that proves the setup really works.'],
  },
  {
    version: '0.128.3',
    date: '2026-09-29',
    changes: ['A company with no email provider is told to choose one under Connectors.'],
  },
  {
    version: '0.128.0',
    date: '2026-08-31',
    changes: ['Transactional messages can go to a list of recipients — each gets their own personalized copy.'],
  },
  {
    version: '0.127.0',
    date: '2026-08-31',
    changes: ['Transactional emails support cc and bcc.'],
  },
  {
    version: '0.126.3',
    date: '2026-08-31',
    changes: ['The domain page shows the Google Postmaster record that the Setup warning asks for.'],
  },
  {
    version: '0.126.0',
    date: '2026-08-31',
    changes: ['If the mail server is briefly down, sends wait and retry instead of being lost.'],
  },
  {
    version: '0.125.0',
    date: '2026-08-30',
    changes: ['Sending-domain setup now follows the email provider you actually use.'],
  },
  {
    version: '0.124.2',
    date: '2026-08-30',
    changes: ['Connectors explain why a channel is off.'],
  },
  {
    version: '0.124.0',
    date: '2026-08-30',
    changes: [
      'Transactional emails can carry attachments.',
      'Personalized values are inserted as plain text, so profile data can’t inject links into your emails.',
    ],
  },
  {
    version: '0.122.0',
    date: '2026-08-30',
    changes: ['Fixed: scheduled broadcasts and automations could stop running after an update.'],
  },
  {
    version: '0.121.0',
    date: '2026-08-30',
    changes: [
      'A Transactional page for messages your own systems trigger (receipts, codes, reminders).',
      'Transactional messages can now be SMS or WhatsApp too.',
    ],
  },
  {
    version: '0.120.0',
    date: '2026-08-30',
    changes: ['Send a designed email to one person from your own systems, through the API.'],
  },
  {
    version: '0.117.0',
    date: '2026-08-30',
    changes: ['Connectors offer our own mail server as an email provider.'],
  },
  {
    version: '0.113.0',
    date: '2026-08-29',
    changes: ['Email can be sent through our own mail server, with bounces and spam reports handled automatically.'],
  },
  {
    version: '0.112.4',
    date: '2026-07-19',
    changes: ['Click a DNS record’s name or value to copy it.'],
  },
  {
    version: '0.112.0',
    date: '2026-07-17',
    changes: [
      'Phone number is a core identifier beside email; numbers are matched however they’re written.',
      'Settings show a red badge when something needs setting up.',
    ],
  },
  {
    version: '0.111.0',
    date: '2026-07-17',
    changes: ['A Setup page lists what’s missing before you can send on each channel.'],
  },
  {
    version: '0.110.0',
    date: '2026-07-17',
    changes: ['“Campaigns” are now called “Automations”.'],
  },
  {
    version: '0.109.0',
    date: '2026-07-16',
    changes: [
      'Connectors: one place to connect email, SMS and WhatsApp providers.',
      'Resend is available as an email provider.',
    ],
  },
  {
    version: '0.108.0',
    date: '2026-07-15',
    changes: ['Each company can store its images in its own Cloudflare R2 bucket.'],
  },
  {
    version: '0.105.1',
    date: '2026-07-15',
    changes: ['Delete a profile and everything recorded about that person.'],
  },
  {
    version: '0.104.0',
    date: '2026-07-10',
    changes: ['Pick an approved WhatsApp template and preview the message, in broadcasts and automations.'],
  },
  {
    version: '0.103.0',
    date: '2026-07-10',
    changes: ['Retry a failed send from the activity log.', 'Filter profiles by email.'],
  },
  {
    version: '0.102.0',
    date: '2026-07-08',
    changes: ['Invite users by email, and reset a forgotten password.', 'The company’s last owner can’t be removed.'],
  },
  {
    version: '0.101.0',
    date: '2026-07-07',
    changes: ['Users now belong to the company; marketers get access per workspace, accounting sees billing only, and ownership can be passed on.'],
  },
  {
    version: '0.100.4',
    date: '2026-07-07',
    changes: ['Fixed: refreshing a brand-new automation lost the draft.'],
  },
  {
    version: '0.100.0',
    date: '2026-07-07',
    changes: ['Automations can start when someone leaves a segment, not just when they enter.'],
  },
  {
    version: '0.99.25',
    date: '2026-07-06',
    changes: ['SMS settings warn about an invalid sender name and explain the provider’s error codes.'],
  },
  {
    version: '0.99.21',
    date: '2026-07-06',
    changes: ['Emails always include an unsubscribe footer, and images and links work in every inbox.'],
  },
  {
    version: '0.99.20',
    date: '2026-07-06',
    changes: ['Send failures are recorded and shown instead of quietly reporting zero sent.'],
  },
  {
    version: '0.99.18',
    date: '2026-07-06',
    changes: ['Sending guardrails: a frequency cap (X messages per Y days) and quiet hours per weekday, in your timezone.'],
  },
  {
    version: '0.99.15',
    date: '2026-07-06',
    changes: ['Public write keys let your website send profiles and events directly (Workspace settings → API keys).'],
  },
  {
    version: '0.99.13',
    date: '2026-07-04',
    changes: ['A public API reference page for creating profiles and posting events.'],
  },
  {
    version: '0.99.11',
    date: '2026-07-04',
    changes: ['Your company logo appears at the top of the sidebar.'],
  },
  {
    version: '0.99.0',
    date: '2026-07-03',
    changes: ['Frequency cap and quiet hours are enforced on every send; failed text messages retry.'],
  },
  {
    version: '0.98.0',
    date: '2026-07-02',
    changes: ['Create, submit and delete WhatsApp message templates without leaving the app.'],
  },
  {
    version: '0.97.0',
    date: '2026-07-02',
    changes: ['Automations can send WhatsApp template messages.'],
  },
  {
    version: '0.95.0',
    date: '2026-07-01',
    changes: ['Broadcasts can send WhatsApp template messages, with a template picker.'],
  },
  {
    version: '0.94.0',
    date: '2026-07-01',
    changes: ['Connect a real WhatsApp Business account.'],
  },
  {
    version: '0.93.2',
    date: '2026-07-01',
    changes: ['Dates show as day/month/year everywhere.'],
  },
  {
    version: '0.93.0',
    date: '2026-07-01',
    changes: ['Broadcasts, automations, segments and profiles have page numbers and search.'],
  },
  {
    version: '0.92.0',
    date: '2026-06-30',
    changes: ['Filter profiles on the fly with the same rule builder segments use.'],
  },
  {
    version: '0.91.0',
    date: '2026-06-30',
    changes: ['A richer broadcast audience: combine rules, and include or exclude segments.'],
  },
  {
    version: '0.90.0',
    date: '2026-06-29',
    changes: ['Automation branches take less room on the canvas.'],
  },
  {
    version: '0.88.0',
    date: '2026-06-29',
    changes: ['Move a step to just after where two branches rejoin.'],
  },
  {
    version: '0.84.0',
    date: '2026-06-28',
    changes: ['Hour windows in automations support half hours.'],
  },
  {
    version: '0.83.0',
    date: '2026-06-26',
    changes: ['Branch on a journey value in an If or a wait-until condition.'],
  },
  {
    version: '0.82.0',
    date: '2026-06-26',
    changes: ['Duplicating a step lets you drop the copy anywhere in the journey.'],
  },
  {
    version: '0.79.0',
    date: '2026-06-25',
    changes: ['Wait-until can wait for a time before or after a date — for example, a day before an appointment.'],
  },
  {
    version: '0.78.0',
    date: '2026-06-25',
    changes: ['The selected automation step stays highlighted and centered, even after a refresh.'],
  },
  {
    version: '0.77.0',
    date: '2026-06-25',
    changes: ['Wait-until can require both a time and a condition, or either one.'],
  },
  {
    version: '0.76.0',
    date: '2026-06-25',
    changes: ['Wait-until steps: wait for a time, a condition, or both, with a maximum wait.'],
  },
  {
    version: '0.75.0',
    date: '2026-06-24',
    changes: ['Segments can match dates more than a set time in the future.'],
  },
  {
    version: '0.74.0',
    date: '2026-06-24',
    changes: ['Switch writing direction (right-to-left or left-to-right) in SMS and WhatsApp messages.'],
  },
  {
    version: '0.73.0',
    date: '2026-06-24',
    changes: ['Reorder the values an “Update profile” step sets; a value can use the ones above it.'],
  },
  {
    version: '0.72.0',
    date: '2026-06-24',
    changes: ['On a profile’s subscriptions, a topic needs a channel and turning everything off unsubscribes.'],
  },
  {
    version: '0.70.0',
    date: '2026-06-24',
    changes: ['Pan the automation canvas freely in every direction.'],
  },
  {
    version: '0.69.0',
    date: '2026-06-24',
    changes: [
      'Journey values: store something during an automation and use it later in the same journey.',
      'Tag each automation message with a topic; see and change each person’s subscriptions.',
    ],
  },
  {
    version: '0.68.0',
    date: '2026-06-23',
    changes: ['An If step can branch on a profile attribute, the trigger event, a segment or an event.'],
  },
  {
    version: '0.67.0',
    date: '2026-06-23',
    changes: ['Broadcast and automation emails open in a side drawer, so you never leave the page.'],
  },
  {
    version: '0.66.0',
    date: '2026-06-22',
    changes: ['Segment fields suggest your workspace’s real profile attributes.'],
  },
  {
    version: '0.65.0',
    date: '2026-06-22',
    changes: ['A redesigned preference center with your logo, two columns and toggle switches.'],
  },
  {
    version: '0.63.0',
    date: '2026-06-22',
    changes: ['Every skipped or failed send shows the reason; phone numbers are normalized.'],
  },
  {
    version: '0.62.0',
    date: '2026-06-22',
    changes: ['Company settings split into tabs: Settings, Workspaces, Sending and Billing.'],
  },
  {
    version: '0.61.0',
    date: '2026-06-22',
    changes: ['Choose the language of the public unsubscribe pages: English, Hebrew, or the reader’s own.'],
  },
  {
    version: '0.59.0',
    date: '2026-06-22',
    changes: ['Your company logo appears on the unsubscribe and preference pages.'],
  },
  {
    version: '0.58.0',
    date: '2026-06-22',
    changes: ['A library of reusable SMS and WhatsApp texts; pick one to fill in a message.'],
  },
  {
    version: '0.57.0',
    date: '2026-06-22',
    changes: ['Send real SMS through 019.'],
  },
  {
    version: '0.56.0',
    date: '2026-06-22',
    changes: ['Unsubscribe links can’t be forged; copy a person’s subscription link from their profile.'],
  },
  {
    version: '0.55.0',
    date: '2026-06-22',
    changes: ['Topics are managed in Workspace settings.'],
  },
  {
    version: '0.54.0',
    date: '2026-06-22',
    changes: ['Automations can send SMS and WhatsApp messages.'],
  },
  {
    version: '0.53.0',
    date: '2026-06-22',
    changes: ['The app works on phones and tablets.'],
  },
  {
    version: '0.52.0',
    date: '2026-06-22',
    changes: ['Subscription topics and a public preference center where people choose what they get.'],
  },
  {
    version: '0.51.0',
    date: '2026-06-22',
    changes: ['Broadcasts can go out by SMS and WhatsApp.'],
  },
  {
    version: '0.50.0',
    date: '2026-06-22',
    changes: ['Open tracking, and a broadcast funnel: sent, delivered, opened, clicked, unsubscribed.'],
  },
  {
    version: '0.49.0',
    date: '2026-06-21',
    changes: ['Event filters suggest values and handle nested fields.', 'The activity log expands each row to show its details.'],
  },
  {
    version: '0.47.0',
    date: '2026-06-21',
    changes: ['Moving or duplicating a step affects just that step.', 'Event types autocomplete from your workspace.'],
  },
  {
    version: '0.45.0',
    date: '2026-06-21',
    changes: ['Publish an automation from the list; a Journeys tab shows who’s in it.'],
  },
  {
    version: '0.44.0',
    date: '2026-06-21',
    changes: ['Delete an automation that was never published.'],
  },
  {
    version: '0.43.0',
    date: '2026-06-21',
    changes: ['Automations can start when a profile is created or updated.'],
  },
  {
    version: '0.41.4',
    date: '2026-06-20',
    changes: ['Drag to pan the automation canvas; pinch or Ctrl+scroll to zoom.'],
  },
  {
    version: '0.41.0',
    date: '2026-06-20',
    changes: ['Automation version history: see past versions and bring one back as a draft.', 'Choose whether publishing also enrolls people already in the segment.'],
  },
  {
    version: '0.39.0',
    date: '2026-06-20',
    changes: ['Move or duplicate a step or a whole branch on the canvas.'],
  },
  {
    version: '0.38.0',
    date: '2026-06-20',
    changes: ['“Update profile” can set several values at once, including calculated ones.'],
  },
  {
    version: '0.37.0',
    date: '2026-06-20',
    changes: ['Name an If condition; zoom the automation map.'],
  },
  {
    version: '0.36.0',
    date: '2026-06-20',
    changes: ['Automations get a list page and their own edit page, with pause, resume and archive.'],
  },
  {
    version: '0.35.0',
    date: '2026-06-20',
    changes: ['If branches split and rejoin into a single path.'],
  },
  {
    version: '0.34.0',
    date: '2026-06-20',
    changes: ['Edit each automation step in its own panel; publishing checks the journey is complete.'],
  },
  {
    version: '0.33.0',
    date: '2026-06-19',
    changes: ['A visual automation builder that lays out the journey for you.'],
  },
  {
    version: '0.31.0',
    date: '2026-06-19',
    changes: ['Automations can start from an event, or by adding people by hand.'],
  },
  {
    version: '0.30.0',
    date: '2026-06-19',
    changes: ['Automation steps for “only during these hours” and calling a webhook.'],
  },
  {
    version: '0.29.0',
    date: '2026-06-19',
    changes: ['Set your workspace’s timezone.'],
  },
  {
    version: '0.27.0',
    changes: ['Row actions are grouped into one ⋮ menu.'],
  },
  {
    version: '0.26.0',
    changes: ['Sending requires a real From sender, a To and a Subject — there’s no no-reply fallback.'],
  },
  {
    version: '0.14.0',
    changes: ['A library template is just a design; From, To and Subject belong to each broadcast’s or automation’s copy.'],
  },
  {
    version: '0.12.0',
    changes: ['Registering creates your company; you then create its first workspace.'],
  },
  {
    version: '0.11.0',
    date: '2026-06-16',
    changes: ['Company owners can register.'],
  },
  {
    version: '0.9.0',
    date: '2026-06-16',
    changes: ['Drag elements between rows in the email editor’s structure panel.'],
  },
  {
    version: '0.8.0',
    date: '2026-06-16',
    changes: ['From, To and Subject live on each email rather than on the template.'],
  },
  {
    version: '0.7.0',
    date: '2026-06-15',
    changes: ['A delivery-health dashboard for your workspace.'],
  },
  {
    version: '0.6.0',
    date: '2026-06-15',
    changes: ['Set From, To and Subject for each broadcast and automation.'],
  },
  {
    version: '0.5.0',
    date: '2026-06-15',
    changes: ['Floating notifications, and a warning before sending without a verified domain.'],
  },
  {
    version: '0.4.0',
    date: '2026-06-14',
    changes: ['Opt-in click tracking for all outgoing email.'],
  },
  {
    version: '0.3.0',
    date: '2026-06-14',
    changes: ['A richer broadcasts list with delivered, failed and clicked counts.'],
  },
  {
    version: '0.2.0',
    date: '2026-06-14',
    changes: ['Edit your own account details.'],
  },
  {
    version: '0.1.4',
    date: '2026-06-14',
    changes: ['Domain setup shows SPF and DMARC records too, and marks each record it can see.'],
  },
  {
    version: '0.1.0',
    date: '2026-06-14',
    changes: ['Billing & usage moved into Company settings.'],
  },
];
