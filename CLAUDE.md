# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Single-page "Image Combiner" app: the user uploads two images, the browser POSTs them to a same-origin Vercel function, which forwards them to an n8n webhook and streams back the combined image. Plain static HTML/CSS/vanilla JS plus one Vercel function — no framework, no build step, no dependencies, no test suite. Deployed to Vercel (Framework: "Other", no build command).

## Commands

- Run locally: `npx vercel dev` (runs the static page **and** `api/generate.mjs`, loading `.env`). `npx serve` only serves static files, so Generate will 404 under it.
- Syntax-check JS: `node --check app.js && node --check api/generate.mjs`
- Deploy: `npx vercel` (or push to GitHub with Vercel import)

## Architecture

- `api/generate.mjs` is the only server code (Web-standard `export async function POST(request)`). It rejects cross-origin requests, re-validates both uploads (size cap + magic-byte type detection), forwards them to `N8N_WEBHOOK_URL` with an optional `X-Webhook-Secret` header, and streams the image back. Error responses are JSON `{ error }`, and `app.js` shows that message to the user.
- Secrets live in `.env` (gitignored, excluded by `.vercelignore`); `.env.example` documents them. Production values are set in Vercel project settings. Never put the webhook URL in client code.
- `vercel.json` sets the function's `maxDuration` and site-wide security headers, including a strict CSP (`connect-src 'self'`, only Google Fonts allowed externally). Adding any external script, style, font or fetch target requires updating the CSP.
- Upload size: Vercel caps function request bodies at 4.5 MB, so each file is limited to 2 MB (`MAX_UPLOAD_BYTES` in `app.js` must equal `MAX_FILE_BYTES` in `api/generate.mjs`). `prepareImage()` in `app.js` downscales/re-encodes larger files to WebP (JPEG fallback) before sending.

- `index.html` holds all markup; `app.js` binds to it via IDs (`generate`, `error`, `result`, `download`) and `.upload-card[data-slot]` elements. The `data-slot` value (`image1` / `image2`) is used directly as the state key and the multipart field name, so renaming it breaks both.
- `app.js` uses a single `state` object (`image1`, `image1Preview`, `image2`, `image2Preview`, `generatedImage`, `isGenerating`, `error`) and one `render()` function that syncs the whole DOM from state. Mutate state, then call `render()` — don't touch the DOM elsewhere.
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
- MVP scope only — no auth, database, history, prompts, navigation, or extra features.
