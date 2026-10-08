// The plain-text alternative and RFC 2047 headers — both deliverability fixes.
import { describe, it, expect } from 'vitest';
import { buildMimeMessage } from '../src/smtp-client.js';
import { htmlToPlainText, encodeHeaderWord, encodeAddressHeader, isAsciiHeader } from '../src/mime-text.js';

describe('htmlToPlainText', () => {
  it('keeps a link’s URL, since "click here" with nothing to click is useless', () => {
    expect(htmlToPlainText('<p>Please <a href="https://x.com/c?t=1">confirm</a> now</p>')).toBe(
      'Please confirm (https://x.com/c?t=1) now',
    );
    // No point repeating a URL that is already its own label.
    expect(htmlToPlainText('<a href="https://x.com">https://x.com</a>')).toBe('https://x.com');
  });

  it('turns block structure into line breaks', () => {
    expect(htmlToPlainText('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(htmlToPlainText('a<br>b')).toBe('a\nb');
    expect(htmlToPlainText('<ul><li>x</li><li>y</li></ul>')).toBe('- x\n- y');
  });

  it('drops style and script rather than printing them as text', () => {
    expect(htmlToPlainText('<style>.a{color:red}</style><p>hi</p>')).toBe('hi');
    expect(htmlToPlainText('<script>var a=1</script><p>hi</p>')).toBe('hi');
  });

  it('decodes the entities compiled MJML actually emits', () => {
    expect(htmlToPlainText('<p>Tom&nbsp;&amp;&nbsp;Jerry</p>')).toBe('Tom & Jerry');
    expect(htmlToPlainText('<p>&lt;not a tag&gt;</p>')).toBe('<not a tag>');
  });

  // A table-based MJML layout leaves enormous runs of blank lines once stripped.
  it('collapses the whitespace a table layout leaves behind', () => {
    const mjmlish = '<table><tr><td>  <div>\n\n hello \n\n</div>  </td></tr><tr><td></td></tr></table>';
    expect(htmlToPlainText(mjmlish)).toBe('hello');
  });

  it('keeps Hebrew intact', () => {
    expect(htmlToPlainText('<p>שלום עולם</p>')).toBe('שלום עולם');
  });
});

describe('RFC 2047 headers', () => {
  it('leaves ASCII alone — most mail must not change shape', () => {
    expect(isAsciiHeader('Hello there')).toBe(true);
    expect(encodeHeaderWord('Hello there')).toBe('Hello there');
    expect(encodeAddressHeader('Acme <hello@acme.com>')).toBe('Acme <hello@acme.com>');
    expect(encodeAddressHeader('hello@acme.com')).toBe('hello@acme.com');
  });

  it('encodes a Hebrew subject as a base64 encoded-word that decodes back', () => {
    const out = encodeHeaderWord('אשרו את הרישום לבגרות');
    expect(out).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = out
      .split(/\r\n /)
      .map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)![1]!, 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe('אשרו את הרישום לבגרות');
  });

  // An encoded-word over 75 chars is invalid, and a multi-byte character split
  // across two words decodes to replacement characters — how Hebrew becomes "???".
  it('folds long values into valid words without splitting a character', () => {
    const long = 'אשרו את הרישום לבגרות עוד היום כדי לא לפספס את המועד האחרון שנקבע';
    const out = encodeHeaderWord(long);
    const words = out.split(/\r\n /);
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = words
      .map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)![1]!, 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(long);
    expect(decoded).not.toContain('�');
  });

  // Encoding the whole string would put an encoded-word where a mailbox belongs and
  // the message would be unroutable.
  it('encodes only the display name, never the address', () => {
    const out = encodeAddressHeader('הודעות מערכת - תלמידים פלוס <noreply@talmidimplus.com>');
    expect(out).toMatch(/^=\?UTF-8\?B\?/);
    expect(out).toContain('<noreply@talmidimplus.com>');
    expect(out).not.toMatch(/=\?UTF-8\?B\?[^?]*\?=.*=\?UTF-8\?B\?[^?]*\?=@/);
  });

  it('quotes an ASCII name only when it holds a special', () => {
    expect(encodeAddressHeader('Acme, Inc <a@b.com>')).toBe('"Acme, Inc" <a@b.com>');
    expect(encodeAddressHeader('Acme Inc <a@b.com>')).toBe('Acme Inc <a@b.com>');
  });
});

describe('buildMimeMessage deliverability', () => {
  const base = { from: 'Acme <hello@acme.com>', to: 'jane@example.com', subject: 'Hi', html: '<p>hello</p>' };

  // An HTML-only message is a long-standing spam signal: every real mail client
  // sends both parts, and filters notice when something does not.
  it('always sends a plain-text alternative beside the html', () => {
    const mime = buildMimeMessage(base, 'm-1', 'acme.com');
    expect(mime).toMatch(/Content-Type: multipart\/alternative/);
    expect(mime).toMatch(/Content-Type: text\/plain; charset=UTF-8/);
    expect(mime).toMatch(/Content-Type: text\/html; charset=UTF-8/);
    expect(mime).toContain('hello');
  });

  // In a multipart/alternative the LAST part wins, so text first / html second.
  it('orders text before html so the html is what clients show', () => {
    const mime = buildMimeMessage(base, 'm-1', 'acme.com');
    expect(mime.indexOf('text/plain')).toBeLessThan(mime.indexOf('text/html'));
  });

  it('encodes a Hebrew subject and sender in the headers', () => {
    const mime = buildMimeMessage(
      { ...base, from: 'תלמידים פלוס <noreply@talmidimplus.com>', subject: 'אשרו את הרישום' },
      'm-2',
      'acme.com',
    );
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(mime).toMatch(/From: =\?UTF-8\?B\?.*<noreply@talmidimplus\.com>/);
    // No raw non-ASCII may survive in the header block.
    const head = mime.split('\r\n\r\n')[0]!;
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(head)).toBe(false);
  });
});
