// CloudZio AI — Stripe Customer Portal launcher
//
// Called from the website when a logged-in, subscribed customer clicks
// "Manage billing" or "Cancel subscription". Looks up their Stripe
// customer ID in `customer_access` and asks Stripe for a one-time portal
// link, which the browser then redirects to. Stripe's own hosted page
// handles everything from there (card updates, plan changes, cancelling),
// and Stripe's webhook (stripe-webhook function) keeps `customer_access`
// in sync automatically when something changes.
//
// Required secrets (set in Supabase: Edge Functions -> create-portal-session -> Secrets):
//   STRIPE_SECRET_KEY - same Stripe secret key used by stripe-webhook
//   SB_URL             - Supabase project URL
//   SB_SECRET_KEY      - Supabase secret API key (sb_secret_...)
//
// Called from the browser like:
//   fetch(FUNCTION_URL, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "Authorization": "Bearer " + (the logged-in user's Supabase access token),
//     },
//     body: JSON.stringify({ flow: "cancel" }) // or { flow: "billing" }
//   })
// Returns: { url: "https://billing.stripe.com/..." } to redirect to.

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  Deno.env.get("SB_URL")!,
  Deno.env.get("SB_SECRET_KEY")!,
);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Not signed in" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Verify the token and find out who's asking.
    const { data: userData, error: userError } = await supabaseAdmin.auth
      .getUser(accessToken);
    if (userError || !userData?.user?.email) {
      return new Response(JSON.stringify({ error: "Not signed in" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const email = userData.user.email.toLowerCase();

    // Look up their Stripe customer ID.
    const { data: row, error: rowError } = await supabaseAdmin
      .from("customer_access")
      .select("stripe_customer_id, status")
      .eq("email", email)
      .maybeSingle();

    if (rowError || !row?.stripe_customer_id) {
      return new Response(
        JSON.stringify({ error: "No subscription found for this account" }),
        {
          status: 404,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    let body: { flow?: string } = {};
    try {
      body = await req.json();
    } catch {
      // no body sent - that's fine, default to the billing home screen
    }

    const returnUrl = "https://www.cloudzio.co.uk/ai/account.html";

    const sessionParams: Stripe.BillingPortal.SessionCreateParams = {
      customer: row.stripe_customer_id,
      return_url: returnUrl,
    };

    if (body.flow === "cancel") {
      // Find their active/trialing subscription so we can jump straight
      // to the cancel-confirmation screen instead of the portal home page.
      const subs = await stripe.subscriptions.list({
        customer: row.stripe_customer_id,
        status: "all",
        limit: 1,
      });
      const sub = subs.data[0];
      if (sub) {
        sessionParams.flow_data = {
          type: "subscription_cancel",
          subscription_cancel: { subscription: sub.id },
          after_completion: {
            type: "redirect",
            redirect: { return_url: returnUrl },
          },
        };
      }
    }

    const portalSession = await stripe.billingPortal.sessions.create(
      sessionParams,
    );

    return new Response(JSON.stringify({ url: portalSession.url }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-portal-session error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
