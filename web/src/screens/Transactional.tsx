// Transactional messages — the API-triggered leg of sending, beside Broadcasts
// (one-off blast) and Automations (a journey).
//
// A transactional message is addressed by a stable KEY that the integrator
// hardcodes ("otp"), so the design behind it can be replaced without anyone
// redeploying. The key namespace spans email and text, so a caller never has to
// say which medium it is.
//
// This screen exists because the alternative — a flag hidden behind a row menu on
// the templates list — left people unable to find where these are made at all.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { clearEditorReturn } from '../store/editorReturn.js';
import { Button, Card, PageHeader, EmptyState, ActionMenu, Badge, Drawer, Field, Input, Select, Textarea } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { askConfirm } from '../ui/dialog.tsx';
import { designToMjml } from '../email-designer/mjml-serializer.js';
import { emptyDesign } from '../email-designer/model.js';

type Medium = 'email' | 'sms' | 'whatsapp';

interface EmailRow {
  id: string;
  name: string;
  transactional_key: string | null;
}
interface TextRow {
  id: string;
  name: string;
  body: string;
  transactional_key: string | null;
  transactional_medium: string | null;
}

/** One row of the list, whichever table it came from. */
interface Item {
  id: string;
  name: string;
  key: string;
  medium: Medium;
  body?: string;
}

const MEDIUM_LABEL: Record<Medium, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

export function Transactional() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');

  // The text composer doubles as create and edit; a null target means closed.
  const [textDraft, setTextDraft] = useState<{
    id: string | null;
    name: string;
    key: string;
    medium: 'sms' | 'whatsapp';
    body: string;
  } | null>(null);
  const [textError, setTextError] = useState('');

  // Creating an email asks only for the key; the design happens in the editor.
  const [emailDraft, setEmailDraft] = useState<{ name: string; key: string } | null>(null);
  const [emailError, setEmailError] = useState('');

  const load = async (): Promise<void> => {
    const [emails, texts] = await Promise.all([
      api.get<{ templates: EmailRow[] }>('/templates'),
      api.get<{ templates: TextRow[] }>('/text-templates'),
    ]);
    const list: Item[] = [
      ...emails.templates
        .filter((t) => t.transactional_key)
        .map((t) => ({ id: t.id, name: t.name, key: t.transactional_key!, medium: 'email' as const })),
      ...texts.templates
        .filter((t) => t.transactional_key)
        .map((t) => ({
          id: t.id,
          name: t.name,
          key: t.transactional_key!,
          medium: (t.transactional_medium === 'whatsapp' ? 'whatsapp' : 'sms') as Medium,
          body: t.body,
        })),
    ].sort((a, b) => a.key.localeCompare(b.key));
    setItems(list);
  };

  useEffect(() => {
    void load().catch(() => setError('Could not load transactional messages.'));
  }, []);

  const msg = (e: unknown, fallback: string): string =>
    (e as { error?: string })?.error ?? (e instanceof Error ? e.message : fallback);

  /** Create an email template, key it, then open the designer on it. */
  const createEmail = async (): Promise<void> => {
    if (!emailDraft) return;
    setEmailError('');
    const name = emailDraft.name.trim() || 'Untitled';
    const key = emailDraft.key.trim();
    if (!key) {
      setEmailError('A key is required — this is what your code will refer to.');
      return;
    }
    try {
      // Seed the SAME empty design the designer starts from, serialized the same
      // way: the server compiles MJML strictly and rejects an empty document, so a
      // blank string here 500s instead of creating anything.
      const design = emptyDesign();
      const created = await api.post<{ template: { id: string } }>('/templates', {
        body: { name, mjml: designToMjml(design), design },
      });
      const id = created.template.id;
      try {
        await api.put(`/templates/${id}/transactional-key`, { body: { transactional_key: key } });
      } catch (e) {
        // The template exists but is unkeyed; removing it keeps the list honest
        // rather than leaving a stray untitled draft behind a failed create.
        await api.del(`/templates/${id}`).catch(() => {});
        setEmailError(msg(e, 'Could not set the key.'));
        return;
      }
      setEmailDraft(null);
      clearEditorReturn();
      navigate(`/editor/${id}`);
    } catch (e) {
      setEmailError(msg(e, 'Could not create the email.'));
    }
  };

  /** Create or update a text message and its key in one go. */
  const saveText = async (): Promise<void> => {
    if (!textDraft) return;
    setTextError('');
    const name = textDraft.name.trim();
    const key = textDraft.key.trim();
    const body = textDraft.body.trim();
    if (!name || !body) {
      setTextError('A name and a message body are both required.');
      return;
    }
    if (!key) {
      setTextError('A key is required — this is what your code will refer to.');
      return;
    }
    try {
      let id = textDraft.id;
      if (id) {
        await api.put(`/text-templates/${id}`, { body: { name, body } });
      } else {
        const created = await api.post<{ template: { id: string } }>('/text-templates', { body: { name, body } });
        id = created.template.id;
      }
      try {
        await api.put(`/text-templates/${id}/transactional-key`, {
          body: { transactional_key: key, medium: textDraft.medium },
        });
      } catch (e) {
        if (!textDraft.id) await api.del(`/text-templates/${id}`).catch(() => {});
        setTextError(msg(e, 'Could not set the key.'));
        return;
      }
      setTextDraft(null);
      await load();
      showToast('Transactional message saved.', { tone: 'success' });
    } catch (e) {
      setTextError(msg(e, 'Could not save the message.'));
    }
  };

  /** Take the key off, leaving the design/body as an ordinary reusable template. */
  const unkey = async (it: Item): Promise<void> => {
    const ok = await askConfirm({
      title: 'Stop serving this from the API',
      message: `Calls with "${it.key}" will start failing. The ${
        it.medium === 'email' ? 'design' : 'message'
      } is kept as an ordinary template, so you can put the key back later.`,
      confirmLabel: 'Remove key',
      danger: true,
    });
    if (!ok) return;
    const path = it.medium === 'email' ? `/templates/${it.id}` : `/text-templates/${it.id}`;
    await api.put(`${path}/transactional-key`, { body: { transactional_key: null } });
    await load();
    showToast('Key removed.');
  };

  return (
    <section data-testid="transactional-screen">
      <PageHeader
        title="Transactional messages"
        subtitle="Messages your application triggers over the API — a one-time code, a password reset, a receipt."
        actions={
          <span class="flex gap-2">
            <Button
              data-testid="new-transactional-email"
              onClick={() => {
                setEmailError('');
                setEmailDraft({ name: '', key: '' });
              }}
            >
              New email
            </Button>
            <Button
              data-testid="new-transactional-text"
              variant="secondary"
              onClick={() => {
                setTextError('');
                setTextDraft({ id: null, name: '', key: '', medium: 'sms', body: '' });
              }}
            >
              New SMS / WhatsApp
            </Button>
          </span>
        }
      />

      {error ? (
        <p data-testid="transactional-error" class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {items === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : items.length ? (
        <ul data-testid="transactional-list" class="space-y-2">
          {items.map((it) => (
            <li
              data-testid="transactional-item"
              key={`${it.medium}:${it.id}`}
              class="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card"
            >
              <span class="flex min-w-0 flex-col">
                <span class="flex min-w-0 items-center gap-2">
                  <code class="rounded bg-stone-100 px-2 py-0.5 font-mono text-sm text-ink-900">{it.key}</code>
                  <Badge tone={it.medium === 'email' ? 'success' : 'neutral'}>{MEDIUM_LABEL[it.medium]}</Badge>
                </span>
                <span class="mt-0.5 truncate text-sm text-stone-500">{it.name}</span>
              </span>
              <ActionMenu
                data-testid="transactional-actions"
                items={[
                  {
                    label: it.medium === 'email' ? 'Design email' : 'Edit message',
                    'data-testid': 'transactional-edit',
                    onSelect: () => {
                      if (it.medium === 'email') {
                        clearEditorReturn();
                        navigate(`/editor/${it.id}`);
                      } else {
                        setTextError('');
                        setTextDraft({
                          id: it.id,
                          name: it.name,
                          key: it.key,
                          medium: it.medium === 'whatsapp' ? 'whatsapp' : 'sms',
                          body: it.body ?? '',
                        });
                      }
                    },
                  },
                  {
                    label: 'Remove from the API…',
                    danger: true,
                    'data-testid': 'transactional-unkey',
                    onSelect: () => unkey(it),
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="transactional-list">
          <EmptyState>
            Nothing here yet. Create one, give it a key like <code class="font-mono">otp</code>, and your application
            can send it by that name.
          </EmptyState>
        </div>
      )}

      <Card class="mt-6 p-5" data-testid="transactional-howto">
        <h2 class="text-base font-bold text-ink-900">Sending one</h2>
        <p class="mt-1 text-sm text-stone-600">
          Use a <b>secret key</b> (<code class="font-mono text-xs">sk_live_…</code>) from{' '}
          <b>Workspace settings → API keys</b> — never the public write key, since this sends real mail from your
          verified domain.
        </p>
        <pre class="mt-3 overflow-x-auto rounded-lg bg-stone-900 p-3 text-xs leading-relaxed text-stone-100">
{`POST /v1/send
Authorization: Bearer sk_live_…

{
  "template": "otp",
  "to": "jane@example.com",
  "data": { "code": "123456" }
}`}
        </pre>
        <p class="mt-2 text-sm text-stone-600">
          Everything in <code class="font-mono text-xs">data</code> is available as{' '}
          <code class="font-mono text-xs">{'{{data.code}}'}</code> in the subject and the body. For SMS and WhatsApp,{' '}
          <code class="font-mono text-xs">to</code> is a phone number instead.
        </p>
      </Card>

      {/* New email: name + key, then straight into the designer. */}
      <Drawer
        open={emailDraft !== null}
        onClose={() => setEmailDraft(null)}
        testId="transactional-email-drawer"
        title="New transactional email"
        subtitle="Name it and give it a key — you'll design it next."
        footer={
          <>
            <Button variant="secondary" onClick={() => setEmailDraft(null)}>
              Cancel
            </Button>
            <Button data-testid="transactional-email-create" onClick={createEmail}>
              Create &amp; design
            </Button>
          </>
        }
      >
        <div class="grid gap-3">
          <Field label="Name" hint="For your own reference in this list.">
            <Input
              data-testid="transactional-email-name"
              value={emailDraft?.name ?? ''}
              placeholder="One-time code"
              onInput={(e) => setEmailDraft((d) => (d ? { ...d, name: (e.target as HTMLInputElement).value } : d))}
            />
          </Field>
          <Field label="Key" hint="What your code refers to. Lowercase letters, digits, dashes and underscores.">
            <Input
              data-testid="transactional-email-key"
              value={emailDraft?.key ?? ''}
              placeholder="otp"
              onInput={(e) => setEmailDraft((d) => (d ? { ...d, key: (e.target as HTMLInputElement).value } : d))}
            />
          </Field>
          {emailError ? (
            <p data-testid="transactional-email-error" class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {emailError}
            </p>
          ) : null}
          <p class="text-sm text-stone-500">
            You'll set the From and Subject in the designer. Both are required before it can send.
          </p>
        </div>
      </Drawer>

      {/* Text: everything fits on one form, so there is no second step. */}
      <Drawer
        open={textDraft !== null}
        onClose={() => setTextDraft(null)}
        testId="transactional-text-drawer"
        title={textDraft?.id ? 'Edit transactional message' : 'New transactional SMS / WhatsApp'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTextDraft(null)}>
              Cancel
            </Button>
            <Button data-testid="transactional-text-save" onClick={saveText}>
              Save
            </Button>
          </>
        }
      >
        <div class="grid gap-3">
          <Field label="Name" hint="For your own reference in this list.">
            <Input
              data-testid="transactional-text-name"
              value={textDraft?.name ?? ''}
              placeholder="One-time code (SMS)"
              onInput={(e) => setTextDraft((d) => (d ? { ...d, name: (e.target as HTMLInputElement).value } : d))}
            />
          </Field>
          <Field label="Key" hint="What your code refers to.">
            <Input
              data-testid="transactional-text-key"
              value={textDraft?.key ?? ''}
              placeholder="otp-sms"
              onInput={(e) => setTextDraft((d) => (d ? { ...d, key: (e.target as HTMLInputElement).value } : d))}
            />
          </Field>
          <Field
            label="Channel"
            hint="Unlike a broadcast, nothing downstream picks the channel for a transactional message, so it commits to one."
          >
            <Select
              data-testid="transactional-text-medium"
              value={textDraft?.medium ?? 'sms'}
              onChange={(e) =>
                setTextDraft((d) =>
                  d ? { ...d, medium: (e.target as HTMLSelectElement).value as 'sms' | 'whatsapp' } : d,
                )
              }
            >
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </Select>
          </Field>
          <Field label="Message" hint="Merge tags work here: {{data.code}}, {{customer.first_name}}.">
            <Textarea
              data-testid="transactional-text-body"
              rows={4}
              value={textDraft?.body ?? ''}
              placeholder="Your code is {{data.code}}"
              onInput={(e) => setTextDraft((d) => (d ? { ...d, body: (e.target as HTMLTextAreaElement).value } : d))}
            />
          </Field>
          {textError ? (
            <p data-testid="transactional-text-error" class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {textError}
            </p>
          ) : null}
        </div>
      </Drawer>
    </section>
  );
}
