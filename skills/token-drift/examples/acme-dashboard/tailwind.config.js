/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx,vue,html}'],
  theme: {
    extend: {
      // Tailwind colors point at the CSS custom properties in src/styles/tokens.css
      colors: {
        brand: {
          50: 'var(--color-brand-50)',
          500: 'var(--color-brand-500)',
          600: 'var(--color-brand-600)',
        },
        ink: 'var(--color-gray-900)',
        muted: 'var(--color-gray-500)',
        surface: 'var(--color-surface)',
      },
      borderRadius: {
        card: 'var(--radius-lg)',
      },
    },
  },
  plugins: [],
};
