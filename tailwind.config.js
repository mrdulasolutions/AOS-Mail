/** @type {import('tailwindcss').Config} */
//
// AOS Mail palette — day-only by design.
//   - White/black core: pure surfaces with subtle line + soft-bg neutrals
//   - Semantic accents: red (danger), amber (warning), green (success)
//   - Brand accent: a single restrained tone for primary actions / focus
//
// Existing components still use Tailwind's default palette (gray-100 etc.)
// and `dark:` variants. Those keep working; we just force `dark` off the
// root in App.tsx so the dark-mode rules never activate. New code should
// reach for the `aos-*` tokens below for brand consistency.

export default {
  // We toggle this off at runtime — see App.tsx — but Tailwind still needs
  // the directive to know the strategy.
  darkMode: "class",
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx,html}",
    "./src/extensions-private/**/src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        aos: {
          // Surfaces
          bg: "#FFFFFF", // pure white — primary surface
          "bg-soft": "#FAFAFA", // app chrome, hover backgrounds
          "bg-sunk": "#F4F4F5", // section backgrounds, sidebar contrast
          // Lines & borders
          line: "#E4E4E7", // primary borders + dividers
          "line-strong": "#D4D4D8", // emphasized borders
          // Text
          text: "#111111", // body text
          "text-soft": "#3F3F46", // secondary text
          "text-muted": "#71717A", // tertiary / placeholders
          "text-faint": "#A1A1AA", // disabled / hints
          // Brand accent — single tone, restrained
          accent: "#111111", // pure black for primary buttons / focus
          // Semantic colors
          danger: "#DC2626", // red — errors, destructive actions
          "danger-soft": "#FEE2E2", // red bg for error toasts
          warning: "#F59E0B", // amber — warnings, "needs attention"
          "warning-soft": "#FEF3C7", // amber bg for warning callouts
          success: "#16A34A", // green — confirmations, positive states
          "success-soft": "#DCFCE7", // green bg for success toasts
          info: "#2563EB", // blue used sparingly (links only)
        },
      },
      borderRadius: {
        // Match Apple's rounded-rectangle vocabulary
        aos: "10px",
        "aos-lg": "14px",
      },
      boxShadow: {
        aos: "0 1px 2px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.06)",
        "aos-lg": "0 8px 24px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)",
      },
    },
  },
  plugins: [require("@tailwindcss/forms")],
};
