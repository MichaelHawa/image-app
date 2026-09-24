# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Single-page "Image Combiner" app behind a one-time $9.99 Stripe payment: the user uploads two images, the browser POSTs them to a same-origin Vercel function, which forwards them to an n8n webhook and streams back the combined image. Plain static HTML/CSS/vanilla JS plus one Vercel function — no framework, no build step, no dependencies, no test suite. Deployed to Vercel (Framework: "Other", no build command).

## Commands

- Run locally: `npx vercel dev` (runs the static page **and** `api/generate.mjs`, loading `.env`). `npx serve` only serves static files, so Generate will 404 under it. If the function reports "not configured", the linked project's env isn't being applied; export the file first: `set -a && . ./.env.local && set +a && npx vercel dev`.
- Syntax-check JS: `node --check app.js && node --check api/generate.mjs`
- Deploy: `npx vercel` (or push to GitHub with Vercel import)

## Architecture

- Auth is Supabase Auth (email + password, name stored as `user_metadata.full_name`), called from `app.js` over the REST API (`/auth/v1/...`) with no SDK. The session is kept in `localStorage` and refreshed via `getAccessToken()`. The project URL and **publishable** key are hardcoded in `app.js` (safe to expose); the Supabase URL is also in the CSP `connect-src`. Email-confirmation links return to the site with tokens in the URL hash, which `initAuth()` consumes. Never use the secret/service_role key in client code.
- `api/generate.mjs` is the only Vercel server code (Web-standard `export async function POST(request)`). It rejects cross-origin requests, requires a valid Supabase access token (`Authorization: Bearer`, verified against `SUPABASE_URL/auth/v1/user`, 401 otherwise), requires a `paid` row in `public.purchases` (queried with the user's own token under RLS, 402 otherwise), re-validates both uploads (size cap + magic-byte type detection), forwards them to `N8N_WEBHOOK_URL` with an optional `X-Webhook-Secret` header, and streams the image back. Error responses are JSON `{ error }`, and `app.js` shows that message to the user.
- Payments: a Stripe Payment Link (`PAYMENT_LINK_URL` in `app.js`, opened with `client_reference_id=<user id>`) → Stripe webhook → Supabase Edge Function `supabase/functions/stripe-webhook` (deployed with `verify_jwt: false`, verifies the Stripe signature itself, writes with the service role). It upserts `public.purchases` on `checkout.session.completed` / `async_payment_succeeded`, and sets `status = 'refunded'` on a full `charge.refunded`. It only accepts checkouts whose `payment_link` equals its `PAYMENT_LINK_ID`. The signing secret is in Supabase Vault (`stripe_webhook_secret`), read via `public.get_stripe_webhook_secret()` (service_role only). Schema is in `supabase/migrations/`. This project does **not** auto-grant table privileges to `anon`/`authenticated`/`service_role`, so new tables need explicit `GRANT`s. Stripe is currently in test mode; README "Going live" lists the swap steps.
- Access flow in `app.js`: after any session is established, `checkAccess()` sets `state.access` to `"paid"` or `"none"` from `purchases`. `render()` shows the generator only when paid; otherwise `#paywall`. On return from Stripe (`?checkout=success`) it polls until the webhook lands. A 402 from `/api/generate` sets `access = "none"` without clearing images.
- Signup has no email confirmation ("Confirm email" is off in Supabase Auth), so signup returns a session directly. For an already-registered email Supabase returns a user with empty `identities`, which `submitAuth()` reports as "account already exists".
- Secrets live in `.env` (gitignored, excluded by `.vercelignore`); `.env.example` documents them. Production values are set in Vercel project settings. Never put the webhook URL in client code.
- `vercel.json` sets the function's `maxDuration` and site-wide security headers, including a strict CSP (`connect-src` is `'self'` plus the Supabase project; otherwise only Google Fonts allowed externally). Adding any external script, style, font or fetch target requires updating the CSP.
- Upload size: Vercel caps function request bodies at 4.5 MB, so each file is limited to 2 MB (`MAX_UPLOAD_BYTES` in `app.js` must equal `MAX_FILE_BYTES` in `api/generate.mjs`). `prepareImage()` in `app.js` downscales/re-encodes larger files to WebP (JPEG fallback) before sending.

- `index.html` holds all markup; `app.js` binds to it via IDs (`generate`, `error`, `result`, `download`) and `.upload-card[data-slot]` elements. The `data-slot` value (`image1` / `image2`) is used directly as the state key and the multipart field name, so renaming it breaks both.
- `app.js` uses a single `state` object (`image1`, `image1Preview`, `image2`, `image2Preview`, `generatedImage`, `isGenerating`, `error`, plus auth: `session`, `authReady`, `authMode`, `authBusy`, `authError`, `authMessage`, plus access: `access`, `accessChecking`, `paywallError`, `paywallMessage`) and one `render()` function that syncs the whole DOM from state. Mutate state, then call `render()` — don't touch the DOM elsewhere.
- Visibility is toggled with the `hidden` attribute; `style.css` enforces it with `[hidden] { display: none !important; }`.
- Preview and result images are object URLs; old ones are revoked with `URL.revokeObjectURL` when replaced.

## Webhook contract (n8n)

- Browser → `/api/generate` and function → n8n are both `multipart/form-data` with fields named exactly `image1` and `image2`. Never set `Content-Type` manually on a `FormData` body — the boundary must be generated.
- n8n must respond with a **binary image, not JSON**; the function rejects non-`image/*` responses, and `app.js` reads the result with `response.blob()` and verifies it decodes before display.
- n8n should authenticate the webhook with Header Auth (`X-Webhook-Secret` = `N8N_WEBHOOK_SECRET`). The browser never talks to n8n directly.

## Constraints from the spec

- Accepted uploads: JPEG/JPG, PNG and WebP only (`ALLOWED_TYPES` / `ALLOWED_EXTENSIONS`).
- Uploaded images must never be cleared on error; duplicate generate requests are blocked via `isGenerating`.
- Visual style is light, minimal, editorial (modeled on the Rinascente screenshot in the repo): white background, black text, thin borders, pill buttons, uppercase letter-spaced labels, Jost font. Cards side-by-side on desktop, stacked under 720px.
- MVP scope only — email/password login and a one-time paid unlock are the only account features; the only table is `purchases`; no history, prompts, navigation, or extra features.
