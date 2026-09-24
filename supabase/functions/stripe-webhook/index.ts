// Stripe webhook → public.purchases. Deployed with verify_jwt = false; every
// request is authenticated by its Stripe-Signature header instead. The signing
// secret is read from Supabase Vault (public.get_stripe_webhook_secret()).
import { createClient } from "npm:@supabase/supabase-js@2";

// Only checkouts from this payment link grant access.
const PAYMENT_LINK_ID = "plink_1UInhlRyQhy4BpSmdHRIDsXd";
const SIGNATURE_TOLERANCE_SECONDS = 300;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

let cachedSecret: string | null = null;

async function getWebhookSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const { data, error } = await supabase.rpc("get_stripe_webhook_secret");
  if (error || !data) throw new Error(`Webhook secret unavailable: ${error?.message ?? "not set"}`);
  cachedSecret = data as string;
  return cachedSecret;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Implements Stripe's scheme: HMAC-SHA256 of "<t>.<payload>", compared with
// every v1 signature in the header.
async function verifySignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = header.split(",").map((p) => p.split("=", 2));
  const timestamp = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = toHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)),
  );
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
async function resolveUserId(session: any): Promise<string | null> {
  const ref = session.client_reference_id;
  if (ref && UUID_RE.test(ref)) {
    const { data } = await supabase.auth.admin.getUserById(ref);
    if (data?.user) return data.user.id;
  }
  const email = session.customer_details?.email;
  if (!email) return null;
  const { data, error } = await supabase.rpc("find_user_id_by_email", { p_email: email });
  if (error) throw new Error(`User lookup failed: ${error.message}`);
  return (data as string | null) ?? null;
}

// deno-lint-ignore no-explicit-any
async function recordCheckout(session: any, status: "paid" | "failed") {
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

  const { error } = await supabase.from("purchases").upsert(
    {
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
    { onConflict: "stripe_checkout_session_id" },
  );
  if (error) throw new Error(`Upsert failed: ${error.message}`);
  console.log(`Recorded ${status} checkout ${session.id} for user ${userId}`);
}

// deno-lint-ignore no-explicit-any
async function recordRefund(charge: any) {
  // Partial refunds keep access; only a full refund revokes it.
  if (!charge.refunded || !charge.payment_intent) return;
  const { error } = await supabase
    .from("purchases")
    .update({ status: "refunded", updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", charge.payment_intent);
  if (error) throw new Error(`Refund update failed: ${error.message}`);
  console.log("Recorded refund for", charge.payment_intent);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const payload = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  let valid = false;
  try {
    valid = await verifySignature(payload, signature, await getWebhookSecret());
  } catch (err) {
    console.error(err);
    return new Response("Webhook not configured", { status: 500 });
  }
  if (!valid) return new Response("Invalid signature", { status: 400 });

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
});
