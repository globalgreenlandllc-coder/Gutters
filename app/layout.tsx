import type { Metadata } from "next";
import { Inter, Archivo_Black, Space_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { SessionProvider } from "@/components/auth/session-provider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const display = Archivo_Black({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

const mono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "GutterScan — Instant AI Gutter Takeoff",
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
          colorPrimary: "#2e40e8",
          colorText: "#0d0d12",
          colorBackground: "#ffffff",
          colorInputBackground: "#ffffff",
          colorInputText: "#0d0d12",
          borderRadius: "0.5rem",
        },
      }}
    >
      <html
        lang="en"
        className={`${inter.variable} ${display.variable} ${mono.variable}`}
      >
        <body className="font-sans antialiased text-zinc-900">
          <SessionProvider>{children}</SessionProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
