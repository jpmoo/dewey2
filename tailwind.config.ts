import type { Config } from "tailwindcss";

const config: Config = {
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
      colors: {
        dewey: {
          cream: "#faf9f6",
          ink: "#1a1a1a",
          mute: "#6b6b6b",
          border: "#e8e6e1",
          accent: "#2563eb",
        },
      },
    },
  },
  plugins: [],
};

export default config;
