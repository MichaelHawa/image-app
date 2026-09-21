# Image Combiner

A single-page web app that combines two images. Upload two images, press **Generate Image**, and an n8n workflow returns one combined image, which the app displays and lets you download.

Built with plain HTML, CSS and JavaScript plus one Vercel serverless function. No framework, no build step, no dependencies.

## How it works

```
Browser ──multipart (image1, image2)──▶ /api/generate (Vercel function) ──▶ n8n webhook
Browser ◀──────── binary image ─────────  /api/generate ◀──── binary image ── n8n
```

The browser never talks to n8n directly. The function keeps the webhook URL and secret server-side, checks both uploads before forwarding them, and passes back only valid image responses.

- **Supported uploads:** JPG/JPEG, PNG, WebP
- **Size limit:** 2 MB per image after processing. Larger images are shrunk in the browser before upload, because Vercel caps function request bodies at 4.5 MB.

## Project structure

| Path | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The page: uploads, previews, generate button, result |
| `api/generate.mjs` | Server-side proxy to the n8n webhook |
| `vercel.json` | Function timeout and security headers |
| `.env.example` | Template for the required environment variables |

## Configuration

Copy `.env.example` to `.env` and fill it in:

| Variable | Required | Description |
|---|---|---|
| `N8N_WEBHOOK_URL` | Yes | Production URL of the n8n Webhook node |
| `N8N_WEBHOOK_SECRET` | Recommended | Sent as the `X-Webhook-Secret` header; must match the n8n Header Auth credential |

`.env` is gitignored and excluded from Vercel uploads. Never commit it.

## n8n setup

In the workflow's **Webhook** node:

1. Set **HTTP Method** to `POST`.
2. Set **Authentication** to **Header Auth** and create a credential with name `X-Webhook-Secret` and a long random value. Use the same value for `N8N_WEBHOOK_SECRET`.
3. Set **Respond** to use a **Respond to Webhook** node that returns the generated image as **binary data**, not JSON.

The workflow receives two binary fields named `image1` and `image2`.

## Run locally

```bash
npx vercel dev
```

This serves the page and runs `api/generate.mjs` with the variables from `.env`, usually at http://localhost:3000. The first run asks you to log in to Vercel and link the project.

`npx serve` shows the page but can't run the function, so **Generate Image** won't work under it.

## Deploy to Vercel

1. Push the repository to GitHub and import it in Vercel. Set **Framework Preset** to **Other** and leave the build command empty.
2. In **Settings → Environment Variables**, add `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_SECRET`.
3. Deploy.

Alternatively, run `npx vercel --prod` from the project folder.

### Recommended: rate limiting

`/api/generate` rejects requests from other websites, but a script can still call it directly, and every call runs your n8n workflow. Add a rate-limit rule for `/api/generate` in your Vercel project's **Firewall** settings (for example, 10 requests per minute per IP).

### Timeout

The function may run for up to 120 seconds (`maxDuration` in `vercel.json`), and the n8n request gives up after 110 seconds. Adjust both if your workflow is slower or your Vercel plan allows less.

## Troubleshooting

| Message in the app | Likely cause |
|---|---|
| "The image service is not configured." | `N8N_WEBHOOK_URL` isn't set (locally in `.env`, or in Vercel's environment variables) |
| "Image generation failed. Please try again." | n8n returned an error. Check the webhook secret, whether the workflow is active, and the n8n execution log. |
| "The image service returned an invalid response." | The workflow responded with JSON or text instead of a binary image |
| "Image generation timed out." | The workflow took longer than 110 seconds |
| Generate returns 404 locally | You're using `npx serve` instead of `npx vercel dev` |
