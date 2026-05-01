import { ComingSoon } from "@/components/admin/coming-soon";

export default function AdminApiKeysPage() {
  return (
    <ComingSoon
      title="API key vault"
      description="Encrypted-at-rest storage for Google Maps, OpenAI, Nearmap, Resend, and Stripe keys. Rotate without redeploying."
      bullets={[
        "AES-256 encryption with APP_ENCRYPTION_KEY at rest",
        "Audit log every reveal/rotate/revoke (who, when, IP)",
        "Health check per provider — last-used timestamp + last error",
        "One-click rotate with overlap window so no AI run drops",
      ]}
    />
  );
}
