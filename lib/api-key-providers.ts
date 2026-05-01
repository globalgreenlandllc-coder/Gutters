import type { ApiKeyProvider } from "@prisma/client";

export const ALL_PROVIDERS: ApiKeyProvider[] = [
  "GOOGLE_MAPS",
  "GOOGLE_SOLAR",
  "OPENAI",
  "NEARMAP",
  "EAGLEVIEW",
  "RESEND",
  "STRIPE_SECRET",
  "STRIPE_WEBHOOK",
];
