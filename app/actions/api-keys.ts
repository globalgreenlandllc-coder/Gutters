"use server";

import { revalidatePath } from "next/cache";
import type { ApiKeyProvider, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encrypt, decrypt, fingerprint } from "@/lib/crypto";
import { getMe } from "./me";

async function requireAdmin() {
  const me = await getMe();
  if (!me || me.user.role !== "SUPER_ADMIN") {
    throw new Error("Forbidden");
  }
  return me;
}

export type ApiKeyRow = {
  id: string;
  provider: ApiKeyProvider;
  label: string;
  fingerprint: string;
  active: boolean;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
};

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  await requireAdmin();
  const rows = await db.apiKey.findMany({
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    fingerprint: r.fingerprint,
    active: r.active,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    rotatedAt: r.rotatedAt ? r.rotatedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createApiKey(args: {
  provider: ApiKeyProvider;
  label: string;
  value: string;
}): Promise<{ ok: true; id: string }> {
  const me = await requireAdmin();
  const value = args.value.trim();
  if (value.length < 8) {
    throw new Error("Key value looks too short to be a real credential.");
  }
  const fp = fingerprint(value);
  const dup = await db.apiKey.findUnique({
    where: { provider_fingerprint: { provider: args.provider, fingerprint: fp } },
  });
  if (dup) {
    throw new Error(
      "This exact key value is already stored for this provider. Rotate the existing entry instead.",
    );
  }

  await db.apiKey.updateMany({
    where: { provider: args.provider, active: true },
    data: { active: false, rotatedAt: new Date() },
  });

  const created = await db.apiKey.create({
    data: {
      provider: args.provider,
      label: args.label.trim() || `${args.provider} key`,
      encryptedValue: encrypt(value),
      fingerprint: fp,
      active: true,
      createdBy: me.user.id,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: me.user.id,
      action: "API_KEY_CREATED",
      targetType: "ApiKey",
      targetId: created.id,
      payload: {
        provider: args.provider,
        fingerprint: fp,
        label: created.label,
      } as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/admin/api-keys");
  return { ok: true, id: created.id };
}

export async function revealApiKey(
  id: string,
): Promise<{ value: string; fingerprint: string; provider: ApiKeyProvider }> {
  const me = await requireAdmin();
  const row = await db.apiKey.findUnique({ where: { id } });
  if (!row) throw new Error("Not found");

  await db.auditLog.create({
    data: {
      actorId: me.user.id,
      action: "API_KEY_VIEWED",
      targetType: "ApiKey",
      targetId: id,
      payload: {
        provider: row.provider,
        fingerprint: row.fingerprint,
      } as Prisma.InputJsonValue,
    },
  });

  return {
    value: decrypt(row.encryptedValue),
    fingerprint: row.fingerprint,
    provider: row.provider,
  };
}

export async function revokeApiKey(id: string): Promise<{ ok: true }> {
  const me = await requireAdmin();
  const before = await db.apiKey.findUnique({ where: { id } });
  if (!before) throw new Error("Not found");
  await db.apiKey.update({
    where: { id },
    data: { active: false, rotatedAt: new Date() },
  });
  await db.auditLog.create({
    data: {
      actorId: me.user.id,
      action: "API_KEY_REVOKED",
      targetType: "ApiKey",
      targetId: id,
      payload: {
        provider: before.provider,
        fingerprint: before.fingerprint,
      } as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/admin/api-keys");
  return { ok: true };
}

export async function rotateApiKey(args: {
  id: string;
  newValue: string;
}): Promise<{ ok: true; id: string }> {
  const me = await requireAdmin();
  const value = args.newValue.trim();
  if (value.length < 8) {
    throw new Error("New key value looks too short to be a real credential.");
  }
  const before = await db.apiKey.findUnique({ where: { id: args.id } });
  if (!before) throw new Error("Not found");

  const fp = fingerprint(value);
  if (fp === before.fingerprint) {
    throw new Error("New value matches the current key — nothing to rotate.");
  }
  const dup = await db.apiKey.findUnique({
    where: {
      provider_fingerprint: { provider: before.provider, fingerprint: fp },
    },
  });
  if (dup) {
    throw new Error(
      "That key value is already stored as a prior row for this provider. Pick a different one.",
    );
  }

  await db.apiKey.update({
    where: { id: args.id },
    data: { active: false, rotatedAt: new Date() },
  });

  const created = await db.apiKey.create({
    data: {
      provider: before.provider,
      label: before.label,
      encryptedValue: encrypt(value),
      fingerprint: fp,
      active: true,
      createdBy: me.user.id,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: me.user.id,
      action: "API_KEY_ROTATED",
      targetType: "ApiKey",
      targetId: created.id,
      payload: {
        provider: before.provider,
        oldId: before.id,
        oldFingerprint: before.fingerprint,
        newFingerprint: fp,
      } as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/admin/api-keys");
  return { ok: true, id: created.id };
}

export type TestApiKeyResult = {
  ok: boolean;
  /** Provider-specific human-readable status. */
  status: string;
  /** Raw error from the provider, if any. Surface in admin UI. */
  error: string | null;
  /** Token fingerprint we tested against — confirms which key was used. */
  testedFingerprint: string | null;
};

/**
 * Validates the stored key for a provider by hitting a lightweight
 * provider endpoint. Designed for the admin "Test" button so you can
 * tell *which* problem you're hitting — bad key vs unverified domain
 * vs network — without composing and sending a real email.
 *
 * Resend: GET /api-keys with the stored key as Bearer auth. Returns
 *   200  → key works, key is valid
 *   401  → invalid / revoked
 *   anything else → bubble Resend's `message` back
 *
 * Anthropic / OpenAI / Fal etc. — not implemented yet; returns a clear
 * "not implemented" status so the UI can surface that gracefully.
 */
export async function testApiKey(
  id: string,
): Promise<TestApiKeyResult> {
  try {
    await requireAdmin();
  } catch (e) {
    return {
      ok: false,
      status: "Not authorized",
      error: e instanceof Error ? e.message : String(e),
      testedFingerprint: null,
    };
  }

  try {
    const row = await db.apiKey.findUnique({ where: { id } });
    if (!row) {
      return {
        ok: false,
        status: "Key not found",
        error: null,
        testedFingerprint: null,
      };
    }

    let value: string;
    try {
      value = decrypt(row.encryptedValue);
    } catch (e) {
      // Decrypt fails when the stored ciphertext was written with a
      // different APP_ENCRYPTION_KEY than the one currently set, or
      // when the stored value is malformed. Either way, the contractor
      // needs to Rotate the key in this UI, not file a bug.
      return {
        ok: false,
        status: "Could not decrypt stored key (encryption key changed or row corrupt)",
        error: e instanceof Error ? e.message : String(e),
        testedFingerprint: row.fingerprint,
      };
    }
    if (!value) {
      return {
        ok: false,
        status: "Stored key is empty",
        error: null,
        testedFingerprint: row.fingerprint,
      };
    }

    if (row.provider === "RESEND") {
      try {
        const res = await fetch("https://api.resend.com/api-keys", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${value}`,
            "Content-Type": "application/json",
          },
          cache: "no-store",
        });
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          name?: string;
        };
        if (res.ok) {
          return {
            ok: true,
            status: "Resend accepted the key — sending should work",
            error: null,
            testedFingerprint: row.fingerprint,
          };
        }
        return {
          ok: false,
          status: `Resend rejected the key (HTTP ${res.status})`,
          error: body.message ?? body.name ?? `HTTP ${res.status}`,
          testedFingerprint: row.fingerprint,
        };
      } catch (e) {
        return {
          ok: false,
          status: "Network error reaching Resend",
          error: e instanceof Error ? e.message : String(e),
          testedFingerprint: row.fingerprint,
        };
      }
    }

    return {
      ok: false,
      status: `Test not implemented for ${row.provider} yet`,
      error: null,
      testedFingerprint: row.fingerprint,
    };
  } catch (e) {
    console.error("[testApiKey] unexpected throw", e);
    return {
      ok: false,
      status: "Unexpected server error during test",
      error: e instanceof Error ? e.message : String(e),
      testedFingerprint: null,
    };
  }
}

export type SendTestEmailResult = {
  ok: boolean;
  /** Resend's message ID when ok, error message when not. */
  detail: string;
  /** Where the email was sent FROM (so the admin can see the
   *  configured sender). */
  from: string;
  /** Recipient confirmation. */
  to: string;
};

/**
 * Composes + delivers a real test email via the stored Resend key.
 * Lets the admin verify the full pipeline — vault decrypt → Resend
 * accept → actual deliverability — without going through the proposal
 * flow. Returns Resend's message ID on success; the email will land
 * in the recipient's inbox within seconds.
 *
 * Uses sendEmailViaResend so the From / Reply-To rules stay identical
 * to a real proposal send. If the contractor has set RESEND_FROM_EMAIL
 * to their verified domain, the test will come from there too.
 */
export async function sendTestEmail(args: {
  to: string;
}): Promise<SendTestEmailResult> {
  try {
    const me = await requireAdmin();
    const trimmed = args.to.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return {
        ok: false,
        detail: "Recipient email looks invalid (need name@domain.tld).",
        from: "",
        to: trimmed,
      };
    }
    const { sendEmailViaResend } = await import("@/lib/email/resend");
    const fromName = me.profile.contractorName || "Gutters Admin";
    const fromEmail =
      process.env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev";
    const res = await sendEmailViaResend({
      to: trimmed,
      fromName,
      replyTo: me.user.email,
      subject: "Gutters — Resend deliverability test",
      html:
        `<div style="font-family:system-ui,sans-serif;color:#0f172a;line-height:1.5">` +
        `<h2 style="margin:0 0 8px">Resend test ✓</h2>` +
        `<p>If you're reading this, your Resend API key + sender domain are wired correctly and proposals will go out.</p>` +
        `<p style="color:#64748b;font-size:13px">Sent from the Gutters admin console at ${new Date().toISOString()}.</p>` +
        `</div>`,
      text:
        "Resend test — if you're reading this, your Resend API key + sender domain are wired correctly and proposals will go out.\n\n" +
        `Sent from the Gutters admin console at ${new Date().toISOString()}.`,
    });
    if (res.ok) {
      return {
        ok: true,
        detail: `Resend accepted the message: ${res.id}. Should land within 30s.`,
        from: `${fromName} <${fromEmail}>`,
        to: trimmed,
      };
    }
    return {
      ok: false,
      detail: res.reason,
      from: `${fromName} <${fromEmail}>`,
      to: trimmed,
    };
  } catch (e) {
    console.error("[sendTestEmail] threw", e);
    return {
      ok: false,
      detail: e instanceof Error ? e.message : "Unexpected error",
      from: "",
      to: args.to,
    };
  }
}

export type ApiKeyAuditEntry = {
  id: string;
  action: string;
  actorEmail: string;
  payload: Record<string, unknown>;
  at: string;
};

export async function listApiKeyAudit(
  limit = 25,
): Promise<ApiKeyAuditEntry[]> {
  await requireAdmin();
  const rows = await db.auditLog.findMany({
    where: {
      action: {
        in: [
          "API_KEY_CREATED",
          "API_KEY_ROTATED",
          "API_KEY_REVOKED",
          "API_KEY_VIEWED",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: true },
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorEmail: r.actor.email,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    at: r.createdAt.toISOString(),
  }));
}
