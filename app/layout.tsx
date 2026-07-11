import type { Metadata } from "next";
import { Inter, Archivo_Black, Space_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { SessionProvider } from "@/components/auth/session-provider";
import { Tracker } from "@/components/analytics/tracker";
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
  title: "GutterScan — AI Takeoffs, Proposals & Payments for Gutter Contractors",
  description:
    "Type one address. Get an AI-measured takeoff, a three-tier proposal your client e-signs, then run the schedule, crew, and payments — all in one platform.",
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
          colorPrimary: "#14688C",
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
          <Tracker />
        </body>
      </html>
    </ClerkProvider>
  );
}
