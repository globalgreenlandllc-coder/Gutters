"use client";

import { useSessionContext } from "@/components/auth/session-provider";

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
  logo: { initials: string; tone: LogoTone; url: string | null };
};

export type Credits = {
  included: number;
  used: number;
  bonus: number;
  resetsAt: string;
};

export type Impersonation = {
  sessionId: string;
  adminUserId: string;
  adminEmail: string;
  startedAt: string;
  reason: string | null;
};

export type Session = {
  user: {
    id: string;
    name: string;
    email: string;
    initials: string;
    provider: "email" | "google" | "other";
    role: "CONTRACTOR" | "SUPER_ADMIN";
  };
  profile: ContractorProfile;
  credits: Credits;
  signedAt: string;
  impersonation?: Impersonation;
};

const DEFAULT_PROFILE: ContractorProfile = {
  company: "",
  contractorName: "",
  email: "",
  phone: "",
  license: "",
  tagline: "",
  logo: { initials: "GU", tone: "emerald", url: null },
};

export function defaultProfile(): ContractorProfile {
  return { ...DEFAULT_PROFILE, logo: { ...DEFAULT_PROFILE.logo } };
}

export function useSession(): { session: Session | null; loading: boolean } {
  const { session, loading } = useSessionContext();
  return { session, loading };
}

export function useProfile(): ContractorProfile {
  const { session } = useSessionContext();
  return session?.profile ?? defaultProfile();
}

export function useUpdateProfile() {
  const { updateProfile } = useSessionContext();
  return updateProfile;
}

export function useConsumeCredit() {
  const { consumeCredit } = useSessionContext();
  return consumeCredit;
}
