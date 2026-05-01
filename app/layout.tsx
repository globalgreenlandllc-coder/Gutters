import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const display = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Gutters — Instant AI Gutter Takeoff",
  description:
    "Type one address. Get an AI-measured estimate, professional proposal, and accept payment in under a minute.",
  metadataBase: new URL("https://gutters.app"),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#059669",
          colorText: "#18181b",
          colorBackground: "#ffffff",
          colorInputBackground: "#ffffff",
          colorInputText: "#18181b",
          borderRadius: "0.75rem",
        },
      }}
    >
      <html lang="en" className={`${inter.variable} ${display.variable}`}>
        <body className="font-sans antialiased text-zinc-900">{children}</body>
      </html>
    </ClerkProvider>
  );
}
