// Attributes that keep browsers and password managers OUT of credential forms.
//
// A form for an integration's credentials (a WhatsApp access token, an R2 key, a
// provider secret) looks like a login to a browser: a text field followed by a
// password field. Left alone, it fills in the signed-in user's OWN saved email and
// password, and those get submitted as the integration's credentials. Spread these
// onto every field of such a form — never onto the real login screens.

/** For the ordinary (non-secret) fields of a credentials form. */
export const NO_AUTOFILL = {
  autocomplete: 'off',
  'data-1p-ignore': 'true', // 1Password
  'data-lpignore': 'true', // LastPass
  'data-bwignore': 'true', // Bitwarden
  'data-form-type': 'other', // Dashlane
} as const;

/**
 * For the secret field itself. Browsers ignore autocomplete="off" on a password
 * input; "new-password" is the value they honour, and it also stops them treating
 * the field before it as the username.
 */
export const SECRET_NO_AUTOFILL = {
  ...NO_AUTOFILL,
  type: 'password',
  autocomplete: 'new-password',
} as const;
