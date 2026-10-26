import { appearanceColors, appearancePlugin } from './tailwind.appearance.js';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Dark mode is a class on <html> (set by store/appearance.ts), not the OS query
  // alone, so the user's explicit choice wins.
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Distinctive pairing (not Inter/Roboto): a characterful grotesque display
        // + a warm, readable UI sans + mono for ids/payloads.
        display: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Hanken Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      // Every neutral + tint is a CSS variable (see tailwind.appearance.js) so ONE
      // class list renders in both light and dark — no dark: variant per element.
      colors: appearanceColors,
      boxShadow: {
        card: '0 1px 2px 0 rgb(12 10 9 / 0.04), 0 1px 3px 0 rgb(12 10 9 / 0.06)',
        soft: '0 4px 16px -4px rgb(12 10 9 / 0.10)',
        glow: '0 6px 20px -6px rgb(13 148 136 / 0.45)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.32s cubic-bezier(0.16,1,0.3,1) both',
        'fade-in': 'fade-in 0.2s ease-out both',
        'slide-in-right': 'slide-in-right 0.28s cubic-bezier(0.16,1,0.3,1) both',
      },
    },
  },
  plugins: [appearancePlugin],
};
