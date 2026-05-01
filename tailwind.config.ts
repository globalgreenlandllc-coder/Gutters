import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
      },
      colors: {
        accent: {
          50: "#ecfdf5",
          100: "#d1fae5",
          200: "#a7f3d0",
          300: "#6ee7b7",
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
          800: "#065f46",
          900: "#064e3b",
        },
      },
      backgroundImage: {
        "grid-light":
          "linear-gradient(rgba(24,24,27,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(24,24,27,0.05) 1px, transparent 1px)",
        "mesh-soft":
          "radial-gradient(at 18% 12%, rgba(167,243,208,0.45) 0px, transparent 45%), radial-gradient(at 85% 8%, rgba(186,230,253,0.45) 0px, transparent 45%), radial-gradient(at 75% 92%, rgba(254,215,170,0.35) 0px, transparent 45%), radial-gradient(at 12% 88%, rgba(196,181,253,0.30) 0px, transparent 45%)",
      },
      backgroundSize: {
        grid: "44px 44px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 16px -2px rgba(15, 23, 42, 0.05)",
        elevated:
          "0 2px 8px rgba(15,23,42,0.06), 0 16px 40px -12px rgba(15,23,42,0.10)",
        glow: "0 0 0 1px rgba(5,150,105,0.18), 0 8px 24px -4px rgba(5,150,105,0.28)",
        "glow-lg":
          "0 0 0 1px rgba(5,150,105,0.22), 0 14px 40px -6px rgba(5,150,105,0.32)",
        "ring-soft":
          "0 0 0 4px rgba(5,150,105,0.10)",
      },
      animation: {
        "fade-in": "fade-in 0.6s ease-out both",
        "slide-up": "slide-up 0.6s ease-out both",
        "pulse-soft": "pulse-soft 3s ease-in-out infinite",
        shimmer: "shimmer 2.4s linear infinite",
        "draw-line": "draw-line 1.6s ease-out forwards",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "draw-line": {
          from: { strokeDashoffset: "1000" },
          to: { strokeDashoffset: "0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
