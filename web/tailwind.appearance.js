// Light/dark theming by palette remap. Each themed color is emitted as
// `rgb(var(--c-<name>-<shade>) / <alpha-value>)`; the variables hold the light
// palette on :root and a remapped one on html.dark. Screens keep plain classes
// (bg-surface, text-stone-500, bg-rose-50 …) and flip automatically.
//
// `.theme-fixed` re-declares the LIGHT variables, so anything inside it keeps its
// designed look in both modes — the always-dark sidebar, code blocks, tooltips,
// and the email designer (an email is previewed on white).
import colors from 'tailwindcss/colors.js';
import plugin from 'tailwindcss/plugin.js';

const brand = {
  50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 300: '#5eead4', 400: '#2dd4bf',
  500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e',
};
const ink = { 700: '#44403c', 800: '#292524', 900: '#1c1917', 950: '#0c0a09' };

const TINTS = { amber: colors.amber, emerald: colors.emerald, indigo: colors.indigo, red: colors.red,
  rose: colors.rose, sky: colors.sky, teal: colors.teal, violet: colors.violet, brand };

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

// Dark neutrals: a warm stone ramp, light end and dark end swapped.
const STONE_DARK = {
  50: '36 32 30', 100: '44 40 37', 200: '62 57 53', 300: '84 78 73', 400: '122 115 110',
  500: '160 152 146', 600: '190 183 178', 700: '214 209 205', 800: '231 229 228',
  900: '245 245 244', 950: '250 250 249',
};
// Tints: pale backgrounds become deep ones and deep text becomes pale; mid shades
// (buttons, badges with white text) stay as they are.
const TINT_SWAP = { 50: 950, 100: 900, 200: 800, 300: 700, 700: 300, 800: 200, 900: 100, 950: 50 };
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const light = {};
const dark = {};
const themed = {};
const add = (name, shade, lightVal, darkVal) => {
  const v = `--c-${name}${shade === null ? '' : `-${shade}`}`;
  light[v] = lightVal;
  dark[v] = darkVal;
  return `rgb(var(${v}) / <alpha-value>)`;
};

themed.surface = add('surface', null, '255 255 255', '28 25 23');
themed.stone = {};
themed.slate = {};
for (const s of SHADES) {
  themed.stone[s] = add('stone', s, rgb(colors.stone[s]), STONE_DARK[s]);
  themed.slate[s] = add('slate', s, rgb(colors.slate[s]), rgb(colors.slate[1000 - s] ?? colors.slate[s]));
}
themed.ink = {};
const INK_DARK = { 700: STONE_DARK[700], 800: STONE_DARK[800], 900: STONE_DARK[900], 950: STONE_DARK[950] };
for (const s of Object.keys(ink)) themed.ink[s] = add('ink', s, rgb(ink[s]), INK_DARK[s]);
for (const [name, pal] of Object.entries(TINTS)) {
  themed[name] = {};
  for (const s of SHADES) themed[name][s] = add(name, s, rgb(pal[s]), rgb(pal[TINT_SWAP[s] ?? s]));
}

export const appearanceColors = themed;

export const appearancePlugin = plugin(({ addBase }) => {
  addBase({
    ':root': light,
    'html.dark': { ...dark, colorScheme: 'dark' },
    'html.dark .theme-fixed, html.dark .nm-designer': { ...light, colorScheme: 'light' },
  });
});
