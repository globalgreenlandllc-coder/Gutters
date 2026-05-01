import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";

export type SendEmailArgs = {
  to: string;
  fromName: string;
  /** Plain "Reply-To" address — homeowner replies go straight to the contractor. */
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; reason: string };

/**
 * Sends a transactional email via Resend using the API key from the vault.
 *
 * "From" address: we use Resend's verified sandbox sender by default
 * (`onboarding@resend.dev`) so this works the moment a key is added — no
 * domain DNS config required. Production deployments can override the
 * sender by setting RESEND_FROM_EMAIL to a verified address on their own
 * domain (e.g. proposals@gutterwise.com).
 */
export async function sendEmailViaResend(
  args: SendEmailArgs,
): Promise<SendEmailResult> {
  const key = await getActiveApiKey("RESEND");
  if (!key) {
    return { ok: false, reason: "Resend key not configured in /admin/api-keys" };
  }

  const fromAddress =
    process.env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev";
  const from = `${escapeFromName(args.fromName)} <${fromAddress}>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        reply_to: args.replyTo ? [args.replyTo] : undefined,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
      cache: "no-store",
    });

    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };

    if (!res.ok) {
      return {
        ok: false,
        reason:
          body.message ?? body.name ?? `Resend HTTP ${res.status}`,
      };
    }
    if (!body.id) {
      return { ok: false, reason: "Resend returned no message id" };
    }
    return { ok: true, id: body.id };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Resend network error",
    };
  }
}

/**
 * Strip characters that would break the RFC-5322 display-name slot. Resend
 * is strict — an unescaped quote or angle bracket here will 422 the request.
 */
function escapeFromName(name: string): string {
  const cleaned = name.replace(/["<>]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "Gutters";
}
