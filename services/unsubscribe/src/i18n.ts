// i18n for the PUBLIC unsubscribe + manage-subscription pages (CLAUDE.md
// front_facing_language). A workspace picks a "front-facing language" in
// settings: 'auto' (the recipient's browser language, from Accept-Language),
// 'en', or 'he'. Hebrew renders RIGHT-TO-LEFT. Everything here is pure +
// deterministic — no I/O — so the handlers stay testable.

/** The persisted workspace setting (workspaces.settings.front_facing_language). */
export type FrontFacingLanguageSetting = 'auto' | 'en' | 'he';

/** The RESOLVED language actually rendered (auto collapses to one of these). */
export type Lang = 'en' | 'he';

/** The accepted values of the workspace setting (validated server-side). */
export const FRONT_FACING_LANGUAGES: readonly FrontFacingLanguageSetting[] = ['auto', 'en', 'he'] as const;

/** Default when unset: follow the recipient's browser. Pages keep working as today. */
export const DEFAULT_FRONT_FACING_LANGUAGE: FrontFacingLanguageSetting = 'auto';

/** Whether a raw value is a valid front_facing_language (for the PUT validator). */
export function isFrontFacingLanguage(v: unknown): v is FrontFacingLanguageSetting {
  return typeof v === 'string' && (FRONT_FACING_LANGUAGES as readonly string[]).includes(v);
}

/**
 * Normalize the persisted setting (missing/unknown → the 'auto' default). Only an
 * explicit 'en'/'he'/'auto' is honored.
 */
export function normalizeFrontFacingLanguage(v: unknown): FrontFacingLanguageSetting {
  return isFrontFacingLanguage(v) ? v : DEFAULT_FRONT_FACING_LANGUAGE;
}

/**
 * Does an Accept-Language header express Hebrew anywhere? Simple substring check
 * on the language subtags (`he`, `he-IL`, `iw` — the legacy ISO code for Hebrew).
 */
export function acceptLanguagePrefersHebrew(acceptLanguage: string | null | undefined): boolean {
  if (!acceptLanguage) return false;
  // Tokens like "he-IL,he;q=0.9,en-US;q=0.8" — scan each subtag's primary code.
  return acceptLanguage
    .toLowerCase()
    .split(',')
    .some((part) => {
      const tag = part.split(';')[0]!.trim();
      return tag === 'he' || tag.startsWith('he-') || tag === 'iw' || tag.startsWith('iw-');
    });
}

/**
 * Resolve the language to render on a public page from the workspace setting and
 * the recipient's Accept-Language header. 'en'/'he' FORCE that language; 'auto'
 * (the default) reads the browser language — Hebrew if the header expresses it,
 * else English. Anything unrecognized falls back to 'auto' semantics.
 */
export function resolveLanguage(
  setting: unknown,
  acceptLanguage: string | null | undefined,
): Lang {
  const s = normalizeFrontFacingLanguage(setting);
  if (s === 'en') return 'en';
  if (s === 'he') return 'he';
  return acceptLanguagePrefersHebrew(acceptLanguage) ? 'he' : 'en';
}

/** The `dir` attribute for a language (Hebrew is RTL). */
export function dirFor(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

/** Every user-facing string on the public pages, keyed by id, per language. */
export interface Strings {
  // /unsubscribe (simple) confirm + done pages
  readonly unsubscribeTitle: string;
  readonly unsubscribeHeading: string;
  /** Body with the email; `{email}` is substituted (the email span stays LTR). */
  readonly unsubscribeBody: string;
  readonly unsubscribeButton: string;
  readonly unsubscribedTitle: string;
  readonly unsubscribedHeading: string;
  readonly unsubscribedBody: string;
  // /manage-subscription preference center
  readonly manageTitle: string;
  readonly manageHeading: string;
  readonly manageIntro: string;
  readonly topicsHeading: string;
  readonly channelsHeading: string;
  readonly noTopics: string;
  readonly channelEmail: string;
  readonly channelSmsWhatsapp: string;
  readonly savePreferences: string;
  readonly unsubscribeFromEverything: string;
  readonly preferencesSavedTitle: string;
  readonly preferencesSavedHeading: string;
  readonly preferencesSavedBody: string;
  // error pages
  readonly invalidOrExpiredTitle: string;
  readonly couldNotVerify: string;
  readonly invalidLinkTitle: string;
  readonly somethingWrongTitle: string;
  readonly tryAgain: string;
  /** Shared "you can close this page" tail. */
  readonly closePage: string;
}

const EN: Strings = {
  unsubscribeTitle: 'Unsubscribe',
  unsubscribeHeading: 'Unsubscribe from these emails?',
  unsubscribeBody: '{email} will no longer receive emails from this sender.',
  unsubscribeButton: 'Yes, unsubscribe me',
  unsubscribedTitle: 'Unsubscribed',
  unsubscribedHeading: "You're unsubscribed",
  unsubscribedBody: "{email} won't receive further emails from this sender. You can close this page.",
  manageTitle: 'Manage your subscription',
  manageHeading: 'Manage your subscription',
  manageIntro: "{email} — choose what you'd like to receive.",
  topicsHeading: 'Topics',
  channelsHeading: 'Channels',
  noTopics: 'This sender has no topics.',
  channelEmail: 'Email',
  channelSmsWhatsapp: 'WhatsApp & SMS',
  savePreferences: 'Save preferences',
  unsubscribeFromEverything: 'Unsubscribe from everything',
  preferencesSavedTitle: 'Preferences saved',
  preferencesSavedHeading: 'Preferences saved',
  preferencesSavedBody: '{email} — your subscription preferences have been updated. You can close this page.',
  invalidOrExpiredTitle: 'Invalid or expired link',
  couldNotVerify: 'This link could not be verified.',
  invalidLinkTitle: 'Invalid link',
  somethingWrongTitle: 'Something went wrong',
  tryAgain: 'Please try again in a moment.',
  closePage: 'You can close this page.',
};

const HE: Strings = {
  unsubscribeTitle: 'ביטול הרשמה',
  unsubscribeHeading: 'לבטל את ההרשמה לדיוור?',
  unsubscribeBody: 'הכתובת {email} לא תקבל יותר דיוור מהשולח הזה.',
  unsubscribeButton: 'כן, בטלו את הרשמתי',
  unsubscribedTitle: 'ההרשמה בוטלה',
  unsubscribedHeading: 'ההרשמה בוטלה',
  unsubscribedBody: 'הכתובת {email} לא תקבל יותר דיוור מהשולח הזה. אפשר לסגור את הדף.',
  manageTitle: 'ניהול ההרשמה',
  manageHeading: 'ניהול ההרשמה',
  manageIntro: '{email} — בחרו מה תרצו לקבל.',
  topicsHeading: 'נושאים',
  channelsHeading: 'ערוצים',
  noTopics: 'לשולח הזה אין נושאים.',
  channelEmail: 'אימייל',
  channelSmsWhatsapp: 'וואטסאפ ו-SMS',
  savePreferences: 'שמירת ההעדפות',
  unsubscribeFromEverything: 'ביטול הרשמה מהכול',
  preferencesSavedTitle: 'ההעדפות נשמרו',
  preferencesSavedHeading: 'ההעדפות נשמרו',
  preferencesSavedBody: 'הכתובת {email} — העדפות ההרשמה עודכנו. אפשר לסגור את הדף.',
  invalidOrExpiredTitle: 'קישור לא תקין או שפג תוקפו',
  couldNotVerify: 'לא ניתן לאמת את הקישור.',
  invalidLinkTitle: 'קישור לא תקין',
  somethingWrongTitle: 'משהו השתבש',
  tryAgain: 'נסו שוב בעוד רגע.',
  closePage: 'אפשר לסגור את הדף.',
};

const TABLE: Record<Lang, Strings> = { en: EN, he: HE };

/** The string bundle for a resolved language. */
export function stringsFor(lang: Lang): Strings {
  return TABLE[lang];
}
