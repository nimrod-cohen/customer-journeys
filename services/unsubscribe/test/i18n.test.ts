// Pure i18n / language-resolution tests for the public pages
// (CLAUDE.md front_facing_language). No I/O.
import { describe, it, expect } from 'vitest';
import {
  resolveLanguage,
  acceptLanguagePrefersHebrew,
  isFrontFacingLanguage,
  normalizeFrontFacingLanguage,
  dirFor,
  stringsFor,
  FRONT_FACING_LANGUAGES,
  DEFAULT_FRONT_FACING_LANGUAGE,
} from '../src/i18n.js';

describe('front_facing_language i18n', () => {
  it('isFrontFacingLanguage accepts only auto/en/he', () => {
    expect(FRONT_FACING_LANGUAGES).toEqual(['auto', 'en', 'he']);
    expect(DEFAULT_FRONT_FACING_LANGUAGE).toBe('auto');
    for (const v of ['auto', 'en', 'he']) expect(isFrontFacingLanguage(v)).toBe(true);
    for (const v of ['fr', 'EN', '', 'english', null, undefined, 1, {}]) {
      expect(isFrontFacingLanguage(v)).toBe(false);
    }
  });

  it('normalizeFrontFacingLanguage falls back to auto for anything unknown', () => {
    expect(normalizeFrontFacingLanguage('he')).toBe('he');
    expect(normalizeFrontFacingLanguage('en')).toBe('en');
    expect(normalizeFrontFacingLanguage('auto')).toBe('auto');
    expect(normalizeFrontFacingLanguage('fr')).toBe('auto');
    expect(normalizeFrontFacingLanguage(undefined)).toBe('auto');
    expect(normalizeFrontFacingLanguage(null)).toBe('auto');
  });

  it('acceptLanguagePrefersHebrew detects he / he-IL / iw anywhere', () => {
    expect(acceptLanguagePrefersHebrew('he-IL,he;q=0.9,en-US;q=0.8')).toBe(true);
    expect(acceptLanguagePrefersHebrew('he')).toBe(true);
    expect(acceptLanguagePrefersHebrew('en-US,en;q=0.9,he;q=0.5')).toBe(true);
    expect(acceptLanguagePrefersHebrew('iw-IL')).toBe(true);
    expect(acceptLanguagePrefersHebrew('en-US,en;q=0.9')).toBe(false);
    expect(acceptLanguagePrefersHebrew('fr-FR')).toBe(false);
    expect(acceptLanguagePrefersHebrew('')).toBe(false);
    expect(acceptLanguagePrefersHebrew(null)).toBe(false);
    expect(acceptLanguagePrefersHebrew(undefined)).toBe(false);
    // Not a false positive on words merely containing "he".
    expect(acceptLanguagePrefersHebrew('the-lang')).toBe(false);
  });

  it("resolveLanguage: 'en'/'he' FORCE the language regardless of Accept-Language", () => {
    expect(resolveLanguage('en', 'he-IL')).toBe('en');
    expect(resolveLanguage('he', 'en-US')).toBe('he');
  });

  it("resolveLanguage: 'auto' (and the default) follow Accept-Language", () => {
    expect(resolveLanguage('auto', 'he-IL,he;q=0.9')).toBe('he');
    expect(resolveLanguage('auto', 'en-US,en;q=0.9')).toBe('en');
    expect(resolveLanguage('auto', null)).toBe('en'); // no header → English
    // Unset/unknown setting behaves like 'auto'.
    expect(resolveLanguage(undefined, 'he')).toBe('he');
    expect(resolveLanguage(undefined, 'en')).toBe('en');
    expect(resolveLanguage('garbage', 'he')).toBe('he');
  });

  it('dirFor: Hebrew is RTL, English is LTR', () => {
    expect(dirFor('he')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
  });

  it('stringsFor: both bundles define every key; Hebrew has the verbatim translations', () => {
    const en = stringsFor('en');
    const he = stringsFor('he');
    // Every key present in BOTH (no missing translation).
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      expect((en as Record<string, string>)[k]).toBeTruthy();
      expect((he as Record<string, string>)[k]).toBeTruthy();
    }
    expect(he.unsubscribeHeading).toBe('לבטל את ההרשמה לדיוור?');
    expect(he.unsubscribeButton).toBe('כן, בטלו את הרשמתי');
    expect(he.manageHeading).toBe('ניהול ההרשמה');
    expect(he.channelSmsWhatsapp).toBe('וואטסאפ ו-SMS');
    expect(he.unsubscribeFromEverything).toBe('ביטול הרשמה מהכול');
    expect(en.unsubscribeHeading).toBe('Unsubscribe from these emails?');
  });
});
