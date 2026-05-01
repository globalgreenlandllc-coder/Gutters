"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const STORAGE_KEY = "gutters.session.v1";

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
    provider: "email" | "google";
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
  return {
    included: 12,
    used,
    bonus: 0,
    resetsAt: reset.toISOString(),
  };
}

const listeners = new Set<() => void>();

function read(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session> & {
      user?: Partial<Session["user"]>;
    };
    if (!parsed?.user?.id) return null;
    return {
      user: {
        id: parsed.user.id,
        name: parsed.user.name ?? "Demo Contractor",
        email: parsed.user.email ?? "demo@gutters.app",
        initials: parsed.user.initials ?? "DC",
        provider: parsed.user.provider ?? "email",
      },
      profile: { ...DEFAULT_PROFILE, ...(parsed.profile ?? {}) },
      credits: parsed.credits ?? defaultCredits(),
      signedAt: parsed.signedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function write(s: Session | null) {
  if (typeof window === "undefined") return;
  if (s) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  else window.localStorage.removeItem(STORAGE_KEY);
  listeners.forEach((l) => l());
}

export function defaultProfile(): ContractorProfile {
  return { ...DEFAULT_PROFILE, logo: { ...DEFAULT_PROFILE.logo } };
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

function nameFromEmail(email: string) {
  const local = email.split("@")[0] ?? "Demo";
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ");
}

export function signIn(
  email?: string,
  opts: { provider?: "email" | "google" } = {},
): Session {
  const e = (email && email.trim()) || "alex@riveragutters.com";
  const name = nameFromEmail(e);
  const session: Session = {
    user: {
      id: "u_demo_1",
      name,
      email: e,
      initials: initialsFromName(name),
      provider: opts.provider ?? "email",
    },
    profile: defaultProfile(),
    credits: defaultCredits(),
    signedAt: new Date().toISOString(),
  };
  write(session);
  return session;
}

export function signOut() {
  write(null);
}

export function updateProfile(patch: Partial<ContractorProfile>) {
  const cur = read();
  if (!cur) return;
  write({
    ...cur,
    profile: {
      ...cur.profile,
      ...patch,
      logo: { ...cur.profile.logo, ...(patch.logo ?? {}) },
    },
  });
}

export function consumeCredit(address: string): {
  ok: boolean;
  reused: boolean;
  remaining: number;
  reason?: string;
} {
  const cur = read();
  if (!cur) return { ok: true, reused: false, remaining: 0 };
  const log = readAddressLog();
  const now = Date.now();
  const within24h = log
    .filter((e) => now - e.at < 24 * 3600 * 1000)
    .filter((e) => e.address.toLowerCase() === address.toLowerCase());
  if (within24h.length > 0 && within24h.length < 10) {
    writeAddressLog([...log, { address, at: now }]);
    return {
      ok: true,
      reused: true,
      remaining: cur.credits.included + cur.credits.bonus - cur.credits.used,
    };
  }
  if (within24h.length >= 10) {
    return {
      ok: false,
      reused: false,
      remaining: cur.credits.included + cur.credits.bonus - cur.credits.used,
      reason: "Same address has been re-run 10 times in the last 24 hours.",
    };
  }
  const total = cur.credits.included + cur.credits.bonus;
  if (cur.credits.used >= total) {
    return {
      ok: false,
      reused: false,
      remaining: 0,
      reason: "Out of credits — upgrade or wait until the next renewal.",
    };
  }
  const next: Session = {
    ...cur,
    credits: { ...cur.credits, used: cur.credits.used + 1 },
  };
  writeAddressLog([...log, { address, at: now }]);
  write(next);
  return {
    ok: true,
    reused: false,
    remaining: total - next.credits.used,
  };
}

const ADDRESS_LOG_KEY = "gutters.address-log.v1";
type AddressLogEntry = { address: string; at: number };

function readAddressLog(): AddressLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ADDRESS_LOG_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AddressLogEntry[];
  } catch {
    return [];
  }
}

function writeAddressLog(entries: AddressLogEntry[]) {
  if (typeof window === "undefined") return;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const trimmed = entries.filter((e) => e.at > cutoff);
  window.localStorage.setItem(ADDRESS_LOG_KEY, JSON.stringify(trimmed));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (typeof window !== "undefined") {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) cb();
    };
    window.addEventListener("storage", handler);
    return () => {
      listeners.delete(cb);
      window.removeEventListener("storage", handler);
    };
  }
  return () => listeners.delete(cb);
}

export function useSession(): { session: Session | null; loading: boolean } {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const session = useSyncExternalStore(
    subscribe,
    () => read(),
    () => null,
  );
  return { session, loading: !hydrated };
}

export function useProfile(): ContractorProfile {
  const { session } = useSession();
  return session?.profile ?? defaultProfile();
}
