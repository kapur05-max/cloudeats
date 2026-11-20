// CloudZio Children's Digital Learning — workbook shop (one function, two jobs)
//
// 1) {action:"checkout"}  -> starts a Stripe Checkout page for the workbook
//    and returns its link. The price is set HERE, not in the browser.
// 2) {action:"download", session_id} -> after payment, checks with Stripe
//    that this session really was paid, then returns a short-lived private
//    download link for the PDF stored in the private "workbooks" bucket.
//
// The PDF is never public: only someone with a paid Stripe session id
// (which only the buyer's browser has) can get a download link.

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SITE = "https://www.cloudzio.co.uk";
const BUCKET = "workbooks";

// Add future workbooks here (id -> name, price in pence, file in the bucket).
const WORKBOOKS: Record<string, { name: string; pence: number; file: string }> = {
  "times-tables": {
    name: "Times Tables Mastery Pack (PDF)",
    pence: 199,
    file: "Times-Tables-Mastery-Pack.pdf",
  },
  "year7-maths": {
    name: "Year 7 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year7-Maths-Mastery-Workbook.pdf",
  },
  "year7-english": {
    name: "Year 7 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year7-English-Skills-Workbook.pdf",
  },
  "year8-maths": {
    name: "Year 8 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year8-Maths-Mastery-Workbook.pdf",
  },
  "year8-english": {
    name: "Year 8 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year8-English-Skills-Workbook.pdf",
  },
  "year9-maths": {
    name: "Year 9 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year9-Maths-Mastery-Workbook.pdf",
  },
  "year9-english": {
    name: "Year 9 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year9-English-Skills-Workbook.pdf",
  },
  "year1-maths": {
    name: "Year 1 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year1-Maths-Mastery-Workbook.pdf",
  },
  "year1-english": {
    name: "Year 1 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year1-English-Skills-Workbook.pdf",
  },
  "year2-maths": {
    name: "Year 2 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year2-Maths-Mastery-Workbook.pdf",
  },
  "year2-english": {
    name: "Year 2 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year2-English-Skills-Workbook.pdf",
  },
  "year3-maths": {
    name: "Year 3 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year3-Maths-Mastery-Workbook.pdf",
  },
  "year3-english": {
    name: "Year 3 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year3-English-Skills-Workbook.pdf",
  },
  "year4-maths": {
    name: "Year 4 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year4-Maths-Mastery-Workbook.pdf",
  },
  "year4-english": {
    name: "Year 4 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year4-English-Skills-Workbook.pdf",
  },
  "year5-maths": {
    name: "Year 5 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year5-Maths-Mastery-Workbook.pdf",
  },
  "year5-english": {
    name: "Year 5 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year5-English-Skills-Workbook.pdf",
  },
  "year6-maths": {
    name: "Year 6 Maths Mastery Workbook (PDF)",
    pence: 199,
    file: "Year6-Maths-Mastery-Workbook.pdf",
  },
  "year6-english": {
    name: "Year 6 English Skills Workbook (PDF)",
    pence: 199,
    file: "Year6-English-Skills-Workbook.pdf",
  },
  "holiday-pack": {
    name: "Holiday Activity Pack (PDF)",
    pence: 199,
    file: "Holiday-Activity-Pack.pdf",
  },
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});
const supabaseAdmin = createClient(Deno.env.get("SB_URL")!, Deno.env.get("SB_SECRET_KEY")!);

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
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { action?: string; id?: string; session_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  try {
    if (body.action === "checkout") {
      const wb = WORKBOOKS[String(body.id ?? "")];
      if (!wb) return json({ error: "Sorry, that workbook isn't available." }, 400);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "gbp",
            unit_amount: wb.pence,
            product_data: { name: wb.name, metadata: { sku: String(body.id) } },
          },
        }],
        metadata: { source: "workbook", workbook: String(body.id) },
        custom_text: {
          submit: { message: "You'll get your download link straight after paying." },
        },
        success_url: `${SITE}/learn/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE}/learn/`,
      });
      return json({ url: session.url });
    }

    if (body.action === "download") {
      const sid = String(body.session_id ?? "");
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return json({ error: "Invalid link." }, 400);
      const session = await stripe.checkout.sessions.retrieve(sid);
      const wb = WORKBOOKS[session.metadata?.workbook ?? ""];
      if (session.metadata?.source !== "workbook" || !wb) {
        return json({ error: "We couldn't find that order." }, 404);
      }
      if (session.payment_status !== "paid") {
        return json({ error: "Payment hasn't been completed yet." }, 402);
      }
      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(wb.file, 600, { download: wb.file });
      if (error || !data?.signedUrl) {
        console.error("signed url failed:", error);
        return json({ error: "Sorry, we couldn't prepare your download. Please email support@cloudzio.co.uk with your receipt." }, 500);
      }
      return json({ url: data.signedUrl });
    }

    return json({ error: "Unknown request." }, 400);
  } catch (err) {
    console.error("workbook-store error:", err);
    return json({ error: "Sorry, something went wrong. Please try again, or email support@cloudzio.co.uk." }, 500);
  }
});
