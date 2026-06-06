// MJML → HTML compilation at template-save time (§11). Uses the `mjml` npm
// package (MIT) in strict validation mode so invalid markup throws rather than
// silently producing broken email HTML. The editor (GrapesJS+MJML) emits MJML;
// this is the single place it becomes cross-client HTML. The ambient `mjml`
// module typing lives in ./mjml.d.ts (listed in tsconfig `files`).
import mjml2html from 'mjml';

/** Thrown when MJML markup fails to compile (invalid tags / structure). */
export class MjmlCompileError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = 'MjmlCompileError';
    this.issues = issues;
  }
}

/**
 * Compile an MJML document to cross-client HTML.
 *
 * Runs the real `mjml` compiler in `strict` validation mode. Any validation
 * errors (unknown tags, malformed structure) throw `MjmlCompileError`; an empty
 * result also throws. On success returns the compiled HTML string. There is no
 * I/O — this is a pure, synchronous transform suitable for unit tests that run
 * the real compiler.
 */
export function compileMjml(mjml: string): string {
  if (typeof mjml !== 'string' || mjml.trim() === '') {
    throw new MjmlCompileError('compileMjml: MJML input is empty', ['empty input']);
  }
  let result: { html: string; errors: { formattedMessage: string }[] };
  try {
    result = mjml2html(mjml, { validationLevel: 'strict' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MjmlCompileError(`compileMjml: invalid MJML — ${message}`, [message]);
  }
  if (result.errors.length > 0) {
    const issues = result.errors.map((e) => e.formattedMessage);
    throw new MjmlCompileError(`compileMjml: invalid MJML — ${issues.join('; ')}`, issues);
  }
  if (!result.html || result.html.trim() === '') {
    throw new MjmlCompileError('compileMjml: compiled HTML was empty', ['empty output']);
  }
  return result.html;
}
