// CloudZio AI — Stripe -> Supabase webhook
//
// Listens for Stripe checkout/subscription events and keeps the
// `customer_access` table in sync, so a customer's account page shows
// which assistants they've paid for.
//
// Required secrets (set in Supabase: Edge Functions -> stripe-webhook -> Secrets):
//   STRIPE_SECRET_KEY    - Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET - signing secret for this endpoint (from Stripe, created after first deploy)
//   SB_URL                - Supabase project URL (not prefixed SUPABASE_, that prefix is reserved)
//   SB_SECRET_KEY          - Supabase secret API key (sb_secret_...)

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabaseAdmin = createClient(
  Deno.env.get("SB_URL")!,
  Deno.env.get("SB_SECRET_KEY")!,
);

// The full set of assistants CloudZio AI currently sells.
const ALL_ASSISTANTS = [
  "Parenting",
  "Shopping",
  "Yoga",
  "Calm",
  "Admin",
  "Tutor",
  "Companion",
];

/**
 * Works out which assistants a purchase grants access to, based on the
 * Stripe product name and (for pick-and-mix bundles) the free-text
 * custom field the customer filled in at checkout.
 */
function assistantsFromProduct(
  productName: string,
  customFieldText: string | null,
): string[] {
  // Strip a leading "CloudZio AI" prefix, with or without a dash after it
  // (bundles are named "CloudZio AI — 3 Assistants", single assistants are
  // named "CloudZio AI Tutor" with no dash).
  const name = productName.replace(/^CloudZio AI\s*(?:[—-]\s*)?/i, "").trim();

  if (/^all 7 assistants$/i.test(name)) {
    return ALL_ASSISTANTS;
  }

  // Pick-and-mix bundles are named like "2 Assistants", "6 Assistants", etc.
  if (/^\d+\s+assistants?$/i.test(name)) {
    if (!customFieldText) return [];
    const typed = customFieldText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // Only keep names that match a real assistant, in case of typos.
    return typed.filter((t) =>
      ALL_ASSISTANTS.some((a) => a.toLowerCase() === t.toLowerCase())
    ).map((t) => ALL_ASSISTANTS.find((a) => a.toLowerCase() === t.toLowerCase())!);
  }

  // Otherwise it's a single assistant product, e.g. "Admin", "Companion".
  const match = ALL_ASSISTANTS.find((a) => a.toLowerCase() === name.toLowerCase());
  return match ? [match] : [];
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      webhookSecret,
    );
  } catch (err) {
    console.error("Signature verification failed:", err);
    return new Response(`Webhook signature verification failed`, {
      status: 400,
    });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const email = session.customer_details?.email ?? session.customer_email;
      if (!email) {
        console.warn("No email on checkout session", session.id);
        return new Response("ok (no email)", { status: 200 });
      }

      const lineItems = await stripe.checkout.sessions.listLineItems(
        session.id,
        { expand: ["data.price.product"] },
      );

      const firstItem = lineItems.data[0];
      const product = firstItem?.price?.product as Stripe.Product | undefined;
      const productName = product?.name ?? "";

      let customFieldText: string | null = null;
      if (session.custom_fields && session.custom_fields.length > 0) {
        customFieldText = session.custom_fields[0].text?.value ?? null;
      }

      const assistants = assistantsFromProduct(productName, customFieldText);

      const { error } = await supabaseAdmin.from("customer_access").upsert({
        email: email.toLowerCase(),
        assistants,
        plan_name: productName,
        stripe_customer_id: typeof session.customer === "string"
          ? session.customer
          : session.customer?.id ?? null,
        stripe_subscription_id: typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null,
        status: "active",
        updated_at: new Date().toISOString(),
      });

      if (error) console.error("Upsert failed:", error);
    }

    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object as Stripe.Subscription;
      const status =
        subscription.status === "active" || subscription.status === "trialing"
          ? "active"
          : "canceled";

      const { error } = await supabaseAdmin
        .from("customer_access")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("stripe_subscription_id", subscription.id);

      if (error) console.error("Status update failed:", error);
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return new Response("internal error", { status: 500 });
  }
});
