import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import {
  PRO_PLAN,
  getStripe,
  getStripeWebhookSecret,
  invoiceSubscriptionId,
  mapStripeSubStatus,
  subscriptionPeriodEnd,
} from "@/lib/stripe";
import { getPlanPricing } from "@/lib/plan-pricing";

export const maxDuration = 30;

/**
 * Stripe webhook — the single writer for platform billing state:
 *
 *   checkout.session.completed (kind=credits)  → grant bonus credits +
 *     CREDIT_TOPUP transaction (idempotent on payment intent id)
 *   invoice.paid                               → upsert Subscription
 *     (ACTIVE, period end), refresh the monthly wallet, SUBSCRIPTION
 *     transaction (idempotent on invoice id)
 *   invoice.payment_failed                     → PAST_DUE
 *   customer.subscription.updated / .deleted   → status sync
 *
 * Endpoint URL for the Stripe dashboard: /api/webhooks/stripe
 * (route is public in middleware.ts; authenticity comes from the
 * signature check against STRIPE_WEBHOOK in the key vault).
 */
export async function POST(request: Request) {
  const [stripe, secret] = await Promise.all([
    getStripe(),
    getStripeWebhookSecret(),
  ]);
  if (!stripe || !secret) {
    return NextResponse.json(
      { error: "Stripe is not configured (STRIPE_SECRET / STRIPE_WEBHOOK)" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (e) {
    console.warn("[stripe-webhook] signature verification failed", e);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.kind === "credits") {
          await grantCredits(session);
        }
        // kind=subscription is handled by invoice.paid (fires for the
        // first payment too) so there's exactly one writer.
        break;
      }
      case "invoice.paid": {
        await handleInvoicePaid(stripe, event.data.object as Stripe.Invoice);
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(inv);
        if (subId) {
          await db.subscription.updateMany({
            where: { stripeSubscriptionId: subId },
            data: { status: "PAST_DUE" },
          });
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        await db.subscription.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: {
            status: mapStripeSubStatus(sub.status),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            currentPeriodEnd: subscriptionPeriodEnd(sub) ?? undefined,
          },
        });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await db.subscription.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: { status: "CANCELED", cancelAtPeriodEnd: false },
        });
        break;
      }
      default:
        break; // acknowledged, unhandled
    }
    return NextResponse.json({ received: true });
  } catch (e) {
    // Non-2xx → Stripe retries with backoff, which is what we want for
    // transient DB failures.
    console.error(`[stripe-webhook] ${event.type} failed`, e);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}

/** Credit-pack purchase → bonus credits. Idempotent: the Transaction's
 *  unique stripePaymentIntentId gates the wallet increment. */
async function grantCredits(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  const credits = Number.parseInt(session.metadata?.credits ?? "", 10);
  if (!userId || !Number.isFinite(credits) || credits <= 0) {
    console.warn("[stripe-webhook] credits session missing metadata", session.id);
    return;
  }
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? `cs_${session.id}`);

  const included = (await getPlanPricing()).pro.includedCredits;
  try {
    await db.$transaction(async (tx) => {
      await tx.transaction.create({
        data: {
          userId,
          type: "CREDIT_TOPUP",
          status: "SUCCEEDED",
          grossCents: session.amount_total ?? 0,
          netCents: session.amount_total ?? 0,
          stripePaymentIntentId: paymentIntentId,
          description: `${credits} estimate credits`,
          settledAt: new Date(),
        },
      });
      await tx.creditWallet.upsert({
        where: { userId },
        create: {
          userId,
          included,
          used: 0,
          bonus: credits,
          resetsAt: nextMonthBoundary(),
        },
        update: { bonus: { increment: credits } },
      });
    });
  } catch (e) {
    // Unique violation on stripePaymentIntentId = retry of an event we
    // already processed — swallow it, anything else bubbles.
    if ((e as { code?: string }).code === "P2002") return;
    throw e;
  }
}

/** First payment + renewals: sync the Subscription row, refresh the
 *  monthly wallet, and record the revenue. */
async function handleInvoicePaid(stripe: Stripe, inv: Stripe.Invoice) {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return; // one-off invoice, not a subscription

  const sub = await stripe.subscriptions.retrieve(subId);
  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id;

  // Resolve the platform user: subscription metadata first, then the
  // Subscription row we stamped with the customer id at checkout time.
  let userId: string | null = sub.metadata?.userId || null;
  if (!userId && customerId) {
    const row = await db.subscription.findFirst({
      where: { stripeCustomerId: customerId },
      select: { userId: true },
    });
    userId = row?.userId ?? null;
  }
  if (!userId) {
    console.warn("[stripe-webhook] invoice.paid: no user mapping", inv.id);
    return;
  }

  const periodEnd = subscriptionPeriodEnd(sub) ?? nextMonthBoundary();
  const pricing = await getPlanPricing();

  await db.subscription.upsert({
    where: { userId },
    create: {
      userId,
      status: mapStripeSubStatus(sub.status),
      planId: PRO_PLAN.id,
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
    update: {
      status: mapStripeSubStatus(sub.status),
      planId: PRO_PLAN.id,
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
  });

  // Fresh month of included credits; purchased bonus carries over.
  await db.creditWallet.upsert({
    where: { userId },
    create: {
      userId,
      included: pricing.pro.includedCredits,
      used: 0,
      bonus: 0,
      resetsAt: periodEnd,
    },
    update: {
      included: pricing.pro.includedCredits,
      used: 0,
      resetsAt: periodEnd,
    },
  });

  // Revenue record, once per invoice.
  const already = await db.transaction.findFirst({
    where: { stripeInvoiceId: inv.id },
    select: { id: true },
  });
  if (!already && (inv.amount_paid ?? 0) > 0) {
    await db.transaction.create({
      data: {
        userId,
        type: "SUBSCRIPTION",
        status: "SUCCEEDED",
        grossCents: inv.amount_paid ?? 0,
        netCents: inv.amount_paid ?? 0,
        stripeInvoiceId: inv.id,
        description: `${pricing.pro.name} — monthly`,
        settledAt: new Date(),
      },
    });
  }
}

function nextMonthBoundary(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0),
  );
}
