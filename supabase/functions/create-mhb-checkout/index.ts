// Mum's Healthy Bites — Stripe Checkout launcher
//
// Called from the shop page (/healthy-bites/) when a customer clicks
// "Checkout". The browser only sends WHAT is in the basket (product ids and
// quantities). This function works out every price itself — from the price
// list below, never from the browser — so nobody can change a price by
// editing the page. It then asks Stripe for a hosted Checkout page (which
// collects the delivery address, phone number and card payment) and returns
// its link for the browser to redirect to.
//
// After payment, Stripe tells the `stripe-webhook` function, which records
// the order in the `mhb_orders` table (see supabase/mhb_orders.sql).
//
// Required secrets (already set for stripe-webhook, they are shared across
// the whole Supabase project):
//   STRIPE_SECRET_KEY - Stripe secret key
//
// IMPORTANT: after creating this function in Supabase, turn OFF
// "Verify JWT" for it (Edge Functions -> create-mhb-checkout -> Details),
// because shoppers are not logged in.
//
// To change a price, the delivery charge or the free-delivery threshold,
// edit the numbers in the PRICING block below (prices are in pence) AND the
// matching numbers in healthy-bites/index.html, then redeploy.

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// ---- PRICING START
type Product = { name: string; pence: number; offer?: string };

const CATALOG: Record<string, Product> = {
  "mille-banana-choco-chip-millet-pancake-m": { name: "Mille Banana Choco Chip Millet Pancake Mix | 250g", pence: 549 },
  "mille-classic-millet-pancake-mix": { name: "Mille Classic Millet Pancake Mix", pence: 549 },
  "alpino-high-protein-super-oats-classic-c": { name: "Alpino High Protein Super Oats | Classic Coffee | 1kg", pence: 749 },
  "alpino-natural-peanut-butter-crunch-400g": { name: "Alpino Natural Peanut Butter Crunch | 400g", pence: 499 },
  "natch-thai-rice-chips-wasabi-100g": { name: "Natch Thai Rice Chips | Wasabi | 100g", pence: 399 },
  "natch-thai-rice-chips-sesame-100g": { name: "Natch Thai Rice Chips | Sesame | 100g", pence: 399 },
  "khetika-raw-makhana-fox-nuts-100g": { name: "Khetika Raw Makhana (Fox Nuts) | 100g", pence: 349 },
  "mille-fusilli-protein-pasta": { name: "Mille Fusilli Protein Pasta", pence: 399 },
  "dal-parivar-moong-dal": { name: "Dal Parivar Moong Dal", pence: 349 },
  "hu-hazelnut-butter-dark-chocolate-bar-60": { name: "Hu Hazelnut Butter Dark Chocolate Bar | 60g", pence: 380 },
  "hu-almond-butter-quinoa-dark-chocolate-b": { name: "Hu Almond Butter & Quinoa Dark Chocolate Bar | 60g", pence: 380 },
  "thf-toasted-pops-cinnamon-rush-35g": { name: "THF Toasted Pops | Cinnamon Rush | 35g", pence: 99 },
  "two-brothers-moringa-powder-100g": { name: "Two Brothers Moringa Powder | 100g", pence: 499 },
  "khetika-flax-seeds-500g": { name: "Khetika Flax Seeds | 500g", pence: 249, offer: "flaxchia" },
  "khetika-chia-seeds-200g": { name: "Khetika Chia Seeds | 200g", pence: 249, offer: "flaxchia" },
  "mille-yeast-protein-dark-chocolate-3-x-3": { name: "Mille Yeast Protein — Dark Chocolate | 3 x 38g", pence: 799 },
  "mille-yeast-protein-coffee-hazelnut-3-x-": { name: "Mille Yeast Protein — Coffee Hazelnut | 3 x 38g", pence: 799 },
  "mille-yeast-protein-unflavoured-3-x-38g": { name: "Mille Yeast Protein — Unflavoured | 3 x 38g", pence: 799 },
  "khetika-super-seeds-mix-200g": { name: "Khetika Super Seeds Mix | 200g", pence: 249 },
  "khetika-watermelon-seeds-200g": { name: "Khetika Watermelon Seeds | 200g", pence: 399 },
  "khetika-pumpkin-seeds-200g": { name: "Khetika Pumpkin Seeds | 200g", pence: 299 },
  "jaggery-powder": { name: "Jaggery Powder", pence: 499 },
  "slurrp-farm-blueberry-millet-healthy-pan": { name: "Slurrp Farm Blueberry Millet Healthy Pancake Mix | 150g", pence: 299, offer: "slurrp" },
  "slurrp-farm-classic-millet-healthy-panca": { name: "Slurrp Farm Classic Millet Healthy Pancake Mix | 150g", pence: 299, offer: "slurrp" },
  "hamper-christmas-treat": { name: "Christmas Treat Hamper", pence: 1500 },
  "hamper-busy-mum-breakfast": { name: "Busy Mum Breakfast Hamper", pence: 1699 },
  "hamper-midlife-nutrition": { name: "Midlife Nutrition Hamper", pence: 3399 },
  "hamper-healthy-snack": { name: "Healthy Snack Hamper", pence: 1799 },
  "hamper-plant-protein": { name: "Plant Protein Hamper", pence: 1649 },
};

// Multi-buy offers: any two products from the same group cost `pairPence`.
const OFFERS: Record<string, { label: string; pairPence: number }> = {
  flaxchia: { label: "Seeds multi-buy: 2 for £4", pairPence: 400 },
  slurrp: { label: "Pancake mix multi-buy: 2 for £5", pairPence: 500 },
};

const FREE_DELIVERY_PENCE = 2500; // free delivery when the total after offers reaches £25
const DELIVERY_FEE_PENCE = 399; // delivery charge below that (£3.99)
const MAX_QTY_PER_ITEM = 20;
const MAX_DISTINCT_ITEMS = 40;

type PricedLine = { id: string; name: string; pence: number; qty: number };
type PricedBasket =
  | {
    ok: true;
    lines: PricedLine[];
    subtotal: number;
    discount: number;
    discountLabels: string[];
    delivery: number;
    total: number;
  }
  | { ok: false; error: string };

function priceBasket(raw: unknown): PricedBasket {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "Your basket is empty." };
  }
  if (raw.length > MAX_DISTINCT_ITEMS) {
    return { ok: false, error: "Too many different items in the basket." };
  }

  // Merge duplicates and validate every line against the price list.
  const qtyById: Record<string, number> = {};
  for (const entry of raw) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const qty = Number(entry?.qty);
    if (!Object.prototype.hasOwnProperty.call(CATALOG, id)) {
      return {
        ok: false,
        error: "One of the items in your basket is no longer available. Please remove it and try again.",
      };
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
      return { ok: false, error: "Please check the quantities in your basket." };
    }
    qtyById[id] = (qtyById[id] ?? 0) + qty;
    if (qtyById[id] > MAX_QTY_PER_ITEM) {
      return { ok: false, error: "Please check the quantities in your basket." };
    }
  }

  const lines: PricedLine[] = Object.keys(qtyById).map((id) => ({
    id,
    name: CATALOG[id].name,
    pence: CATALOG[id].pence,
    qty: qtyById[id],
  }));

  const subtotal = lines.reduce((sum, l) => sum + l.pence * l.qty, 0);

  // Multi-buy offers: within each offer group, pair up the dearest items first.
  let discount = 0;
  const discountLabels: string[] = [];
  for (const offerId of Object.keys(OFFERS)) {
    const unitPrices: number[] = [];
    for (const l of lines) {
      if (CATALOG[l.id].offer === offerId) {
        for (let i = 0; i < l.qty; i++) unitPrices.push(l.pence);
      }
    }
    unitPrices.sort((a, b) => b - a);
    let groupDiscount = 0;
    for (let i = 0; i + 1 < unitPrices.length; i += 2) {
      const pairNormal = unitPrices[i] + unitPrices[i + 1];
      groupDiscount += Math.max(0, pairNormal - OFFERS[offerId].pairPence);
    }
    if (groupDiscount > 0) {
      discount += groupDiscount;
      discountLabels.push(OFFERS[offerId].label);
    }
  }

  const afterOffers = subtotal - discount;
  const delivery = afterOffers >= FREE_DELIVERY_PENCE ? 0 : DELIVERY_FEE_PENCE;
  return {
    ok: true,
    lines,
    subtotal,
    discount,
    discountLabels,
    delivery,
    total: afterOffers + delivery,
  };
}
// ---- PRICING END

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const SITE = "https://www.cloudzio.co.uk";

// 20% off the first order (goods only, after multi-buy offers) plus free delivery.
// "First order" = no earlier order in mhb_orders for the same email address.
const FIRST_ORDER_PERCENT = 20;
const supabaseAdmin = createClient(Deno.env.get("SB_URL")!, Deno.env.get("SB_SECRET_KEY")!);

async function isFirstOrder(email: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("mhb_orders").select("id").eq("email", email).limit(1);
  if (error) {
    console.error("first-order lookup failed:", error);
    return false; // if unsure, don't give the discount
  }
  return (data?.length ?? 0) === 0;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    let body: { items?: unknown; email?: unknown; check?: unknown } = {};
    try {
      body = await req.json();
    } catch (_) {
      return json({ error: "Invalid request." }, 400);
    }

    // The shop page asks "is this email a first order?" so it can show the
    // right totals in the basket before checkout.
    if (body.check === true) {
      const e = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
      return json({ firstOrder: ok && await isFirstOrder(e) });
    }

    const priced = priceBasket(body.items);
    if (!priced.ok) return json({ error: priced.error }, 400);

    // Multi-buy savings are applied as a one-off Stripe coupon so the
    // customer sees them as a line on the Checkout page.
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
    let firstOrderOff = 0;
    if (validEmail && await isFirstOrder(email)) {
      firstOrderOff = Math.round((priced.subtotal - priced.discount) * FIRST_ORDER_PERCENT / 100);
    }
    const totalOff = priced.discount + firstOrderOff;
    // First orders also get free delivery.
    const delivery = firstOrderOff > 0 ? 0 : priced.delivery;

    let discounts: { coupon: string }[] | undefined;
    if (totalOff > 0) {
      const coupon = await stripe.coupons.create({
        amount_off: totalOff,
        currency: "gbp",
        duration: "once",
        // Stripe shows this name on the Checkout page (40 characters max).
        name: firstOrderOff > 0
          ? (priced.discount > 0 ? "Multi-buy + 20% off first order" : "20% off your first order")
          : (priced.discountLabels.length === 1 ? priced.discountLabels[0] : "Multi-buy savings"),
        max_redemptions: 1,
      });
      discounts = [{ coupon: coupon.id }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      locale: "en-GB",
      line_items: priced.lines.map((l) => ({
        quantity: l.qty,
        price_data: {
          currency: "gbp",
          unit_amount: l.pence,
          product_data: { name: l.name, metadata: { sku: l.id } },
        },
      })),
      discounts,
      ...(validEmail ? { customer_email: email } : {}),
      shipping_address_collection: { allowed_countries: ["GB"] },
      phone_number_collection: { enabled: true },
      shipping_options: [{
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: delivery, currency: "gbp" },
          display_name: delivery === 0 ? "Free UK delivery" : "UK delivery",
        },
      }],
      metadata: { source: "mhb" },
      payment_intent_data: { description: "Mum's Healthy Bites order" },
      success_url: `${SITE}/healthy-bites/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}/healthy-bites/`,
    });

    return json({ url: session.url });
  } catch (err) {
    console.error("create-mhb-checkout error:", err);
    return json({ error: "Sorry, we couldn't start checkout. Please try again, or email support@cloudzio.co.uk." }, 500);
  }
});
