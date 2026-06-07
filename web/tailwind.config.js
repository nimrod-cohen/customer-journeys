/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Distinctive pairing (not Inter/Roboto): a characterful grotesque display
        // + a warm, readable UI sans + mono for ids/payloads.
        display: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Hanken Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // Warm-neutral canvas (stone) + a confident teal accent. Semantic tokens
        // map to CSS variables so the whole app stays cohesive.
        ink: {
          950: '#0c0a09',
          900: '#1c1917',
          800: '#292524',
          700: '#44403c',
        },
        brand: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
        },
      },
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
      },
      animation: { 'fade-up': 'fade-up 0.32s cubic-bezier(0.16,1,0.3,1) both' },
    },
  },
  plugins: [],
};
