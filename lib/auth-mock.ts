"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useUser } from "@clerk/nextjs";

const PROFILE_KEY = "gutters.profile.v1";
const CREDITS_KEY = "gutters.credits.v1";
const ADDRESS_LOG_KEY = "gutters.address-log.v1";

export type LogoTone =
  | "emerald"
  | "sky"
  | "indigo"
  | "rose"
  | "amber"
  | "violet"
  | "zinc";

export type ContractorProfile = {
  company: string;
  contractorName: string;
  email: string;
  phone: string;
  license: string;
  tagline: string;
  logo: { initials: string; tone: LogoTone };
};

export type Credits = {
  included: number;
  used: number;
  bonus: number;
  resetsAt: string;
};

export type Session = {
  user: {
    id: string;
    name: string;
    email: string;
    initials: string;
    provider: "email" | "google" | "other";
  };
  profile: ContractorProfile;
  credits: Credits;
  signedAt: string;
};

const DEFAULT_PROFILE: ContractorProfile = {
  company: "Rivera Gutterworks",
  contractorName: "Alex Rivera",
  email: "alex@riveragutters.com",
  phone: "(512) 555-0184",
  license: "TX-RCC-48217",
  tagline: "Texas-licensed gutter craftsmanship since 2014",
  logo: { initials: "RG", tone: "emerald" },
};

function defaultCredits(used = 4): Credits {
  const now = new Date();
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return { included: 12, used, bonus: 0, resetsAt: reset.toISOString() };
}

export function defaultProfile(): ContractorProfile {
  return { ...DEFAULT_PROFILE, logo: { ...DEFAULT_PROFILE.logo } };
}

const listeners = new Set<() => void>();

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
  listeners.forEach((l) => l());
}

function readProfile(): ContractorProfile {
  const stored = readJson<Partial<ContractorProfile> | null>(
    PROFILE_KEY,
    null,
  );
  if (!stored) return defaultProfile();
  return {
    ...defaultProfile(),
    ...stored,
    logo: { ...defaultProfile().logo, ...(stored.logo ?? {}) },
  };
}

function readCredits(): Credits {
  return readJson<Credits>(CREDITS_KEY, defaultCredits());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (typeof window !== "undefined") {
    const handler = (e: StorageEvent) => {
      if (e.key === PROFILE_KEY || e.key === CREDITS_KEY) cb();
    };
    window.addEventListener("storage", handler);
    return () => {
      listeners.delete(cb);
      window.removeEventListener("storage", handler);
    };
  }
  return () => listeners.delete(cb);
}

function getProfileSnapshot() {
  return readProfile();
}
function getCreditsSnapshot() {
  return readCredits();
}
function emptyProfile(): ContractorProfile | null {
  return null;
}
function emptyCredits(): Credits | null {
  return null;
}

function initialsFromName(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .filter(Boolean)
    .slice(0, 2)
    .join("");
}

function detectProvider(
  externalAccounts: Array<{ provider: string }> | undefined,
): "email" | "google" | "other" {
  if (!externalAccounts || externalAccounts.length === 0) return "email";
  const first = externalAccounts[0]?.provider ?? "";
  if (first.includes("google")) return "google";
  return "other";
}

export function useSession(): { session: Session | null; loading: boolean } {
  const { user, isLoaded, isSignedIn } = useUser();
  const profile = useSyncExternalStore<ContractorProfile | null>(
    subscribe,
    getProfileSnapshot,
    emptyProfile,
  );
  const credits = useSyncExternalStore<Credits | null>(
    subscribe,
    getCreditsSnapshot,
    emptyCredits,
  );

  const session = useMemo<Session | null>(() => {
    if (!isLoaded || !isSignedIn || !user) return null;
    const name =
      user.fullName ||
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.username ||
      user.primaryEmailAddress?.emailAddress?.split("@")[0] ||
      "Contractor";
    const email = user.primaryEmailAddress?.emailAddress ?? "";
    const initials = initialsFromName(name) || email.slice(0, 2).toUpperCase();
    return {
      user: {
        id: user.id,
        name,
        email,
        initials,
        provider: detectProvider(user.externalAccounts as { provider: string }[]),
      },
      profile: profile ?? defaultProfile(),
      credits: credits ?? defaultCredits(),
      signedAt: user.lastSignInAt
        ? new Date(user.lastSignInAt).toISOString()
        : new Date().toISOString(),
    };
  }, [isLoaded, isSignedIn, user, profile, credits]);

  return { session, loading: !isLoaded };
}

export function useProfile(): ContractorProfile {
  const profile = useSyncExternalStore<ContractorProfile | null>(
    subscribe,
    getProfileSnapshot,
    emptyProfile,
  );
  return profile ?? defaultProfile();
}

export function updateProfile(patch: Partial<ContractorProfile>) {
  const cur = readProfile();
  writeJson(PROFILE_KEY, {
    ...cur,
    ...patch,
    logo: { ...cur.logo, ...(patch.logo ?? {}) },
  });
}

export function consumeCredit(address: string): {
  ok: boolean;
  reused: boolean;
  remaining: number;
  reason?: string;
} {
  const credits = readCredits();
  const log = readJson<{ address: string; at: number }[]>(ADDRESS_LOG_KEY, []);
  const now = Date.now();
  const within24h = log
    .filter((e) => now - e.at < 24 * 3600 * 1000)
    .filter((e) => e.address.toLowerCase() === address.toLowerCase());

  if (within24h.length > 0 && within24h.length < 10) {
    writeJson(
      ADDRESS_LOG_KEY,
      [...log, { address, at: now }].filter(
        (e) => now - e.at < 24 * 3600 * 1000,
      ),
    );
    return {
      ok: true,
      reused: true,
      remaining: credits.included + credits.bonus - credits.used,
    };
  }
  if (within24h.length >= 10) {
    return {
      ok: false,
      reused: false,
      remaining: credits.included + credits.bonus - credits.used,
      reason: "Same address has been re-run 10 times in the last 24 hours.",
    };
  }
  const total = credits.included + credits.bonus;
  if (credits.used >= total) {
    return {
      ok: false,
      reused: false,
      remaining: 0,
      reason: "Out of credits — upgrade or wait until the next renewal.",
    };
  }
  writeJson(CREDITS_KEY, { ...credits, used: credits.used + 1 });
  writeJson(
    ADDRESS_LOG_KEY,
    [...log, { address, at: now }].filter(
      (e) => now - e.at < 24 * 3600 * 1000,
    ),
  );
  return { ok: true, reused: false, remaining: total - credits.used - 1 };
}
