# Private Sanctuary OGP Worker

Cloudflare Worker for URL preview cards and short AI summaries.

## Deploy

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

After deployment, copy the Worker URL and paste it into the app's detailed settings as `OGP WORKER URL`.

## AI summaries

The Worker uses the Workers AI binding named `AI` in `wrangler.toml`.
Each URL preview can call Workers AI once to generate a short Japanese summary, so watch Cloudflare Workers AI usage if posting many links.

For more natural Japanese summaries, set a Gemini API key as a Worker secret:

```bash
wrangler secret put GEMINI_API_KEY
```

When `GEMINI_API_KEY` is present, Gemini is used first. Without it, the Worker returns an extractive summary from the article text to avoid awkward generated Japanese.

Workers AI generation can still be enabled explicitly with `ENABLE_WORKERS_AI_SUMMARY=true`, but Gemini is recommended for natural Japanese.
