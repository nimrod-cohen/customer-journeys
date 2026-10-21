import { describe, it, expect } from 'vitest';
import { NO_AUTOFILL, SECRET_NO_AUTOFILL } from './autofill.js';

// A credentials form (a WhatsApp token, an R2 key, a provider secret) is NOT a login
// form, but a browser sees "text field then password field" and fills in the user's
// own saved email and password — which then get submitted as the integration's
// credentials. These attributes are what tell browsers and password managers no.
describe('autofill opt-out attributes', () => {
  it('turns autofill off on ordinary credential fields, for browsers and password managers', () => {
    expect(NO_AUTOFILL.autocomplete).toBe('off');
    expect(NO_AUTOFILL['data-1p-ignore']).toBe('true'); // 1Password
    expect(NO_AUTOFILL['data-lpignore']).toBe('true'); // LastPass
    expect(NO_AUTOFILL['data-bwignore']).toBe('true'); // Bitwarden
    expect(NO_AUTOFILL['data-form-type']).toBe('other'); // Dashlane
  });

  // Browsers ignore autocomplete="off" on a password field; "new-password" is the
  // value they honour, and it also stops the field before it being treated as a username.
  it('marks a secret field as a new password so a saved login is never filled in', () => {
    expect(SECRET_NO_AUTOFILL.type).toBe('password');
    expect(SECRET_NO_AUTOFILL.autocomplete).toBe('new-password');
    expect(SECRET_NO_AUTOFILL['data-1p-ignore']).toBe('true');
  });
});
