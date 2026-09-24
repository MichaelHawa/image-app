// Server-side proxy to the n8n webhook. Keeps the webhook URL and secret out
// of the browser, requires a logged-in Supabase user who has paid, and
// validates uploads before they reach n8n.

const MAX_FILE_BYTES = 2 * 1024 * 1024; // keeps two files under Vercel's 4.5 MB body limit
const UPSTREAM_TIMEOUT_MS = 110_000; // just under maxDuration in vercel.json
const AUTH_TIMEOUT_MS = 10_000;

const SIGNATURES = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  "image/webp": (b) =>
    String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
};

function error(status, message) {
  return Response.json({ error: message }, { status });
}

// Detects the real image type from the file's bytes rather than trusting the
// client-supplied MIME type or extension.
function detectType(bytes) {
  return Object.keys(SIGNATURES).find((type) => SIGNATURES[type](bytes)) || null;
}

// Only allow browser requests from this same site. Non-browser clients can
// forge Origin, so abuse protection also needs a Vercel Firewall rate limit.
function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

// Verifies the request's Supabase access token by asking Supabase Auth who it
// belongs to. Returns the user, null if the token is missing or invalid, and
// throws if Supabase can't be reached.
async function getUser(request) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;

  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Supabase auth returned status ${response.status}`);
  return response.json();
}

function supabaseHeaders(token) {
  return {
    apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${token}`,
  };
}

// Whether the user has a paid purchase (written by the stripe-webhook edge
// function). Queried with the user's own token, so RLS limits it to their
// rows. Throws if Supabase can't be reached.
async function hasPaidAccess(token) {
  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/purchases?select=id&status=eq.paid&limit=1`,
    { headers: supabaseHeaders(token), signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error(`Supabase purchases returned status ${response.status}`);
  const rows = await response.json();
  return rows.length > 0;
}

async function readImage(formData, field) {
  const file = formData.get(field);
  if (!(file instanceof File)) return { error: `Missing ${field}.` };
  if (file.size === 0) return { error: `${field} is empty.` };
  if (file.size > MAX_FILE_BYTES) return { error: `${field} is too large.` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectType(bytes);
  if (!type) return { error: `${field} must be a JPG, PNG or WebP image.` };

  return { file: new File([bytes], file.name || field, { type }) };
}

export async function POST(request) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("N8N_WEBHOOK_URL is not set");
    return error(500, "The image service is not configured.");
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    console.error("SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is not set");
    return error(500, "The image service is not configured.");
  }

  if (!isSameOrigin(request)) return error(403, "Forbidden.");

  let user;
  try {
    user = await getUser(request);
  } catch (err) {
    console.error("Supabase auth check failed:", err);
    return error(502, "Couldn't verify your login. Please try again.");
  }
  if (!user) return error(401, "Please log in to generate images.");
  const token = request.headers.get("authorization").slice(7);

  let paid;
  try {
    paid = await hasPaidAccess(token);
  } catch (err) {
    console.error("Supabase purchase check failed:", err);
    return error(502, "Couldn't verify your purchase. Please try again.");
  }
  if (!paid) return error(402, "Purchase access to start generating.");

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return error(415, "Expected multipart/form-data.");
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return error(400, "Invalid upload.");
  }

  const image1 = await readImage(formData, "image1");
  if (image1.error) return error(400, image1.error);
  const image2 = await readImage(formData, "image2");
  if (image2.error) return error(400, image2.error);

  return forwardToN8n(webhookUrl, image1.file, image2.file);
}

// Sends both images to n8n and returns the image response, or a JSON error.
async function forwardToN8n(webhookUrl, image1, image2) {
  const upstreamBody = new FormData();
  upstreamBody.append("image1", image1);
  upstreamBody.append("image2", image2);

  const headers = {};
  if (process.env.N8N_WEBHOOK_SECRET) {
    headers["X-Webhook-Secret"] = process.env.N8N_WEBHOOK_SECRET;
  }

  let upstream;
  try {
    upstream = await fetch(webhookUrl, {
      method: "POST",
      body: upstreamBody,
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("n8n request failed:", err);
    const timedOut = err.name === "TimeoutError";
    return error(timedOut ? 504 : 502, timedOut
      ? "Image generation timed out. Please try again."
      : "Couldn't reach the image service. Please try again.");
  }

  if (!upstream.ok) {
    console.error("n8n returned status", upstream.status);
    return error(502, "Image generation failed. Please try again.");
  }

  const upstreamType = upstream.headers.get("content-type") || "";
  if (!upstreamType.startsWith("image/")) {
    console.error("n8n returned non-image content-type:", upstreamType);
    return error(502, "The image service returned an invalid response.");
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstreamType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
