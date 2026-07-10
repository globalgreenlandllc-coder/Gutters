import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendEmailViaResend } from "@/lib/email/resend";
import { renderReminderEmail } from "@/lib/email/payment-templates";

export const maxDuration = 60;

const MAX_REMINDERS = 4; // per installment, then a human takes over
const COOLDOWN_DAYS = 3; // between automatic nudges

function appBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

/**
 * Daily cron: emails homeowners a payment reminder for every overdue
 * installment on an active (accepted, not completed) job. Throttled to
 * one nudge per installment every COOLDOWN_DAYS, capped at
 * MAX_REMINDERS total — past that the overdue item stays in the
 * contractor's Needs-attention feed for a personal follow-up.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const cooldownCutoff = new Date(
    now.getTime() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    const due = await db.paymentInstallment.findMany({
      where: {
        status: "PENDING",
        dueAt: { lt: now },
        reminderCount: { lt: MAX_REMINDERS },
        OR: [{ remindedAt: null }, { remindedAt: { lt: cooldownCutoff } }],
        proposal: { status: "ACCEPTED", completedAt: null },
      },
      include: {
        proposal: {
          select: {
            publicToken: true,
            address: true,
            clientName: true,
            clientEmail: true,
            contractorSnap: true,
            user: {
              select: {
                contractorProfile: {
                  select: {
                    company: true,
                    stripePaymentUrl: true,
                    squarePaymentUrl: true,
                  },
                },
              },
            },
          },
        },
      },
      take: 50, // safety cap per run
    });

    let sent = 0;
    let skipped = 0;
    const failures: string[] = [];

    for (const inst of due) {
      const p = inst.proposal;
      if (!p.clientEmail) {
        skipped++;
        continue;
      }
      const snap = (p.contractorSnap ?? {}) as {
        company?: string;
        stripePaymentUrl?: string | null;
        squarePaymentUrl?: string | null;
      };
      const live = p.user?.contractorProfile;
      const email = renderReminderEmail({
        clientFirstName:
          (p.clientName || "there").trim().split(/\s+/)[0] || "there",
        companyName: snap.company || live?.company || "Your contractor",
        address: p.address,
        installmentLabel: inst.label,
        amountCents: inst.amountCents,
        dueAt: inst.dueAt,
        overdue: true,
        stripeUrl: snap.stripePaymentUrl ?? live?.stripePaymentUrl ?? null,
        squareUrl: snap.squarePaymentUrl ?? live?.squarePaymentUrl ?? null,
        portalUrl: `${appBaseUrl()}/p/${p.publicToken}`,
      });
      const res = await sendEmailViaResend({
        to: p.clientEmail,
        fromName: snap.company || "GutterScan",
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      if (res.ok) {
        sent++;
        await db.paymentInstallment.update({
          where: { id: inst.id },
          data: { remindedAt: now, reminderCount: { increment: 1 } },
        });
      } else {
        failures.push(`${inst.id}: ${res.reason}`);
      }
    }

    return NextResponse.json({
      ok: true,
      candidates: due.length,
      sent,
      skipped,
      failures,
    });
  } catch (error: unknown) {
    console.error("[payment-reminders] error:", error);
    const message = error instanceof Error ? error.message : "reminders failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
