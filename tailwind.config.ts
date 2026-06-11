import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      // Palette is driven by CSS variables (see globals.css) so it flips with
      // the `.dark` class. <alpha-value> keeps Tailwind opacity modifiers working.
      colors: {
        dewey: {
          cream: "rgb(var(--dewey-cream) / <alpha-value>)",
          ink: "rgb(var(--dewey-ink) / <alpha-value>)",
          mute: "rgb(var(--dewey-mute) / <alpha-value>)",
          border: "rgb(var(--dewey-border) / <alpha-value>)",
          accent: "rgb(var(--dewey-accent) / <alpha-value>)",
          surface: "rgb(var(--dewey-surface) / <alpha-value>)",
          "surface-2": "rgb(var(--dewey-surface-2) / <alpha-value>)",
          primary: "rgb(var(--dewey-primary) / <alpha-value>)",
          "primary-fg": "rgb(var(--dewey-primary-fg) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
