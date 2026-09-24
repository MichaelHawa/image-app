// Stripe webhook → public.subscriptions. Every request is authenticated by
// its Stripe-Signature header, checked against STRIPE_WEBHOOK_SECRET.
// Subscription state is always re-read from the Stripe API (STRIPE_SECRET_KEY)
// so out-of-order events can't regress it. Rows are written with
// SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS, so it must stay server-side.
import { createHmac, timingSafeEqual } from "node:crypto";

// Only checkouts from this payment link grant access.
const PAYMENT_LINK_ID = "plink_1UJH4uRyQhy4BpSm1Z060dqm";
const SIGNATURE_TOLERANCE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 10_000;
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

async function getStripeSubscription(id) {
  const response = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Stripe subscription lookup returned status ${response.status}`);
  return response.json();
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

// The fields of public.subscriptions that mirror Stripe's subscription.
function subscriptionFields(sub) {
  // Newer API versions moved current_period_end onto the subscription items.
  const periodEnd = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return {
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    status: sub.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };
}

// Links a new subscription to the user who checked out.
async function recordCheckout(session) {
  if (session.payment_link !== PAYMENT_LINK_ID || !session.subscription) {
    console.log("Ignoring checkout from another source:", session.id);
    return;
  }

  const userId = await resolveUserId(session);
  if (!userId) {
    // 500 so Stripe retries; the user may not exist yet if they paid first.
    throw new Error(`No user for checkout ${session.id}`);
  }

  const sub = await getStripeSubscription(session.subscription);
  await supabase("/rest/v1/subscriptions?on_conflict=stripe_subscription_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: {
      user_id: userId,
      email: session.customer_details?.email ?? null,
      stripe_subscription_id: sub.id,
      ...subscriptionFields(sub),
    },
  });
  console.log(`Recorded ${sub.status} subscription ${sub.id} for user ${userId}`);
}

// Renewals, failed payments, cancellations: refresh the row if we have one.
async function syncSubscription(eventSub) {
  const sub = await getStripeSubscription(eventSub.id);
  await supabase(`/rest/v1/subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: subscriptionFields(sub),
  });
  console.log(`Synced subscription ${sub.id}: ${sub.status}`);
}

export async function POST(request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
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
        await recordCheckout(event.data.object);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object);
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
