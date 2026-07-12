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
