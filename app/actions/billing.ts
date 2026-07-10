"use server";

import { db } from "@/lib/db";
import {
  CREDIT_PACKS,
  PRO_PLAN,
  creditPack,
  getStripe,
  type CreditPack,
} from "@/lib/stripe";
import { getMe } from "./me";

/* ------------------------------------------------------------------ */
/*  Read: billing state for the settings page                          */
/* ------------------------------------------------------------------ */

export type MyBilling = {
  /** False until an admin adds STRIPE_SECRET to the key vault. */
  configured: boolean;
  plan: {
    status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "INCOMPLETE";
    renewsAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  packs: CreditPack[];
  proPriceCents: number;
  recentTopups: Array<{ id: string; description: string; amountCents: number; at: string }>;
};

export async function getMyBilling(): Promise<MyBilling | null> {
  const me = await getMe();
  if (!me) return null;
  const [stripe, sub, topups] = await Promise.all([
    getStripe(),
    db.subscription.findUnique({ where: { userId: me.user.id } }),
    db.transaction.findMany({
      where: { userId: me.user.id, type: "CREDIT_TOPUP", status: "SUCCEEDED" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, description: true, grossCents: true, createdAt: true },
    }),
  ]);
  return {
    configured: !!stripe,
    plan: sub
      ? {
          status: sub.status,
          renewsAt: sub.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        }
      : null,
    packs: CREDIT_PACKS,
    proPriceCents: PRO_PLAN.priceCents,
    recentTopups: topups.map((t) => ({
      id: t.id,
      description: t.description ?? "Credit top-up",
      amountCents: t.grossCents,
      at: t.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Checkout: Pro subscription + credit packs                          */
/* ------------------------------------------------------------------ */

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

function appBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

/** Finds or creates the Stripe customer for this user, persisting the
 *  id on the Subscription row (created as INCOMPLETE if absent). */
async function ensureStripeCustomer(
  userId: string,
  email: string,
  name: string,
): Promise<string> {
  const stripe = await getStripe();
  if (!stripe) throw new Error("Stripe is not configured");
  const existing = await db.subscription.findUnique({
    where: { userId },
    select: { stripeCustomerId: true },
  });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { userId },
  });
  await db.subscription.upsert({
    where: { userId },
    create: {
      userId,
      status: "INCOMPLETE",
      planId: PRO_PLAN.id,
      stripeCustomerId: customer.id,
    },
    update: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

export async function createSubscriptionCheckout(): Promise<CheckoutResult> {
  try {
    const me = await getMe();
    if (!me) return { ok: false, reason: "Not signed in" };
    const stripe = await getStripe();
    if (!stripe) {
      return {
        ok: false,
        reason:
          "Payments aren't configured yet — add a Stripe secret key in /admin/api-keys.",
      };
    }
    const sub = await db.subscription.findUnique({
      where: { userId: me.user.id },
    });
    if (sub?.status === "ACTIVE" || sub?.status === "PAST_DUE") {
      return { ok: false, reason: "You already have an active plan — use Manage plan." };
    }

    const customerId = await ensureStripeCustomer(
      me.user.id,
      me.user.email,
      me.profile.contractorName || me.user.name,
    );
    const base = appBaseUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: me.user.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: PRO_PLAN.priceCents,
            recurring: { interval: "month" },
            product_data: {
              name: PRO_PLAN.name,
              description: `${PRO_PLAN.includedCredits} AI estimates per month · client portals · payment tracking`,
            },
          },
        },
      ],
      subscription_data: { metadata: { userId: me.user.id } },
      metadata: { userId: me.user.id, kind: "subscription" },
      allow_promotion_codes: true,
      success_url: `${base}/dashboard/settings?billing=success`,
      cancel_url: `${base}/dashboard/settings?billing=cancelled`,
    });
    if (!session.url) return { ok: false, reason: "Stripe returned no checkout URL" };
    return { ok: true, url: session.url };
  } catch (e) {
    console.error("[createSubscriptionCheckout] threw", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Couldn't start checkout",
    };
  }
}

export async function createCreditsCheckout(
  packId: string,
): Promise<CheckoutResult> {
  try {
    const me = await getMe();
    if (!me) return { ok: false, reason: "Not signed in" };
    const pack = creditPack(packId);
    if (!pack) return { ok: false, reason: "Unknown credit pack" };
    const stripe = await getStripe();
    if (!stripe) {
      return {
        ok: false,
        reason:
          "Payments aren't configured yet — add a Stripe secret key in /admin/api-keys.",
      };
    }

    const customerId = await ensureStripeCustomer(
      me.user.id,
      me.user.email,
      me.profile.contractorName || me.user.name,
    );
    const base = appBaseUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      client_reference_id: me.user.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pack.amountCents,
            product_data: {
              name: `${pack.credits} estimate credits`,
              description: `${pack.blurb} · credits never expire`,
            },
          },
        },
      ],
      metadata: {
        userId: me.user.id,
        kind: "credits",
        credits: String(pack.credits),
        packId: pack.id,
      },
      payment_intent_data: {
        metadata: {
          userId: me.user.id,
          kind: "credits",
          credits: String(pack.credits),
        },
      },
      success_url: `${base}/dashboard/settings?billing=credits`,
      cancel_url: `${base}/dashboard/settings?billing=cancelled`,
    });
    if (!session.url) return { ok: false, reason: "Stripe returned no checkout URL" };
    return { ok: true, url: session.url };
  } catch (e) {
    console.error("[createCreditsCheckout] threw", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Couldn't start checkout",
    };
  }
}

/** Stripe-hosted customer portal: update card, cancel, invoices. */
export async function openBillingPortal(): Promise<CheckoutResult> {
  try {
    const me = await getMe();
    if (!me) return { ok: false, reason: "Not signed in" };
    const stripe = await getStripe();
    if (!stripe) return { ok: false, reason: "Payments aren't configured yet" };
    const sub = await db.subscription.findUnique({
      where: { userId: me.user.id },
      select: { stripeCustomerId: true },
    });
    if (!sub?.stripeCustomerId) {
      return { ok: false, reason: "No billing profile yet — upgrade first." };
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${appBaseUrl()}/dashboard/settings`,
    });
    return { ok: true, url: session.url };
  } catch (e) {
    console.error("[openBillingPortal] threw", e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Couldn't open the billing portal",
    };
  }
}
