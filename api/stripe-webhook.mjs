// Stripe webhook → public.purchases. Every request is authenticated by its
// Stripe-Signature header, checked against STRIPE_WEBHOOK_SECRET. Purchases
// are written with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS, so this
// key must stay server-side.
import { createHmac, timingSafeEqual } from "node:crypto";

// Only checkouts from this payment link grant access.
const PAYMENT_LINK_ID = "plink_1UInhlRyQhy4BpSmdHRIDsXd";
const SIGNATURE_TOLERANCE_SECONDS = 300;
const SUPABASE_TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Implements Stripe's scheme: HMAC-SHA256 of "<t>.<payload>", compared with
// every v1 signature in the header.
function verifySignature(payload, header, secret) {
  const parts = header.split(",").map((p) => p.split("=", 2));
  const timestamp = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// Calls Supabase as service_role. Throws unless the response is OK.
async function supabase(path, { method = "GET", body, headers = {} } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Supabase ${method} ${path.split("?")[0]} returned status ${response.status}`);
  }
  return response;
}

async function resolveUserId(session) {
  const ref = session.client_reference_id;
  if (ref && UUID_RE.test(ref)) {
    try {
      const { id } = await (await supabase(`/auth/v1/admin/users/${ref}`)).json();
      if (id) return id;
    } catch {
      // Unknown id; fall back to the checkout email.
    }
  }
  const email = session.customer_details?.email;
  if (!email) return null;
  const response = await supabase("/rest/v1/rpc/find_user_id_by_email", {
    method: "POST",
    body: { p_email: email },
  });
  return (await response.json()) ?? null;
}

async function recordCheckout(session, status) {
  if (session.payment_link !== PAYMENT_LINK_ID) {
    console.log("Ignoring checkout from another source:", session.id);
    return;
  }
  if (status === "paid" && session.payment_status !== "paid") {
    // Async payment methods: wait for checkout.session.async_payment_succeeded.
    console.log("Checkout not paid yet:", session.id, session.payment_status);
    return;
  }

  const userId = await resolveUserId(session);
  if (!userId) {
    // 500 so Stripe retries; the user may not exist yet if they paid first.
    throw new Error(`No user for checkout ${session.id}`);
  }

  await supabase("/rest/v1/purchases?on_conflict=stripe_checkout_session_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: {
      user_id: userId,
      email: session.customer_details?.email ?? null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent ?? null,
      stripe_customer_id: session.customer ?? null,
      amount_total: session.amount_total,
      currency: session.currency,
      status,
      updated_at: new Date().toISOString(),
    },
  });
  console.log(`Recorded ${status} checkout ${session.id} for user ${userId}`);
}

async function recordRefund(charge) {
  // Partial refunds keep access; only a full refund revokes it.
  if (!charge.refunded || !charge.payment_intent) return;
  await supabase(
    `/rest/v1/purchases?stripe_payment_intent_id=eq.${encodeURIComponent(charge.payment_intent)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: { status: "refunded", updated_at: new Date().toISOString() },
    },
  );
  console.log("Recorded refund for", charge.payment_intent);
}

export async function POST(request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("STRIPE_WEBHOOK_SECRET, SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    return new Response("Webhook not configured", { status: 500 });
  }

  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  if (!verifySignature(payload, signature, secret)) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await recordCheckout(event.data.object, "paid");
        break;
      case "checkout.session.async_payment_failed":
        await recordCheckout(event.data.object, "failed");
        break;
      case "charge.refunded":
        await recordRefund(event.data.object);
        break;
      default:
        console.log("Unhandled event type:", event.type);
    }
  } catch (err) {
    console.error(`Failed to handle ${event.type} ${event.id}:`, err);
    return new Response("Handler error", { status: 500 });
  }

  return Response.json({ received: true });
}
