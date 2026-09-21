# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Single-page "Image Combiner" app: the user uploads two images, the browser POSTs them to an n8n webhook, and the combined image n8n returns is displayed. Plain static HTML/CSS/vanilla JS — no framework, no build step, no dependencies, no tests. Deployed to Vercel as a static site (Framework: "Other", no build command).

## Commands

- Run locally: `npx serve` from the repo root (serves on http://localhost:3000)
- Syntax-check JS: `node --check app.js`
- Deploy: `npx vercel` (or push to GitHub with Vercel import)

## Architecture

- `index.html` holds all markup; `app.js` binds to it via IDs (`generate`, `error`, `result`, `download`) and `.upload-card[data-slot]` elements. The `data-slot` value (`image1` / `image2`) is used directly as the state key and the multipart field name, so renaming it breaks both.
- `app.js` uses a single `state` object (`image1`, `image1Preview`, `image2`, `image2Preview`, `generatedImage`, `isGenerating`, `error`) and one `render()` function that syncs the whole DOM from state. Mutate state, then call `render()` — don't touch the DOM elsewhere.
- Visibility is toggled with the `hidden` attribute; `style.css` enforces it with `[hidden] { display: none !important; }`.
- Preview and result images are object URLs; old ones are revoked with `URL.revokeObjectURL` when replaced.

## Webhook contract (n8n)

- `POST` to `WEBHOOK_URL` (top of `app.js`) as `multipart/form-data` with fields named exactly `image1` and `image2`. Do not set `Content-Type` manually — the browser must add the multipart boundary.
- The response is a **binary image, not JSON**; it's read with `response.blob()` and validated by loading it into an `Image` before display.
- Calls go straight from the browser to n8n, so CORS is handled by the n8n Webhook node's "Allowed Origins" option (currently it echoes the request origin).

## Constraints from the spec

- Accepted uploads: JPEG/JPG, PNG and WebP only (`ALLOWED_TYPES` / `ALLOWED_EXTENSIONS`).
- Uploaded images must never be cleared on error; duplicate generate requests are blocked via `isGenerating`.
- Visual style is light, minimal, editorial (modeled on the Rinascente screenshot in the repo): white background, black text, thin borders, pill buttons, uppercase letter-spaced labels, Jost font. Cards side-by-side on desktop, stacked under 720px.
- MVP scope only — no auth, database, history, prompts, navigation, or extra features.
