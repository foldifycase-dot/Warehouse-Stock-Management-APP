# FoldifyCase Warehouse

Proxy backend for the FoldifyCase warehouse stock management app.

## Endpoints

`GET /api/proxy?service=shopify&action=products` — fetch all products with tags
`GET /api/proxy?service=shopify&action=orders&days=90` — fetch orders for sales ranking
`GET /api/proxy?service=shopify&action=locations` — fetch Shopify locations
`POST /api/proxy?service=alert` — send email alert via Resend

## Environment variables (add in Vercel)

| Variable | Description |
|---|---|
| `SHOPIFY_STORE` | e.g. `scnd9y-a1.myshopify.com` |
| `SHOPIFY_TOKEN` | Your Shopify custom app token |
| `RESEND_API_KEY` | From resend.com — free tier is fine |

## File structure

```
foldifycase-warehouse/
├── api/
│   └── proxy.js        ← all backend logic
├── warehouse.html      ← frontend app (add after setup)
├── vercel.json         ← routing config
└── package.json
```

## Setup steps

1. Push this repo to GitHub as `foldifycase-warehouse`
2. Connect to a new Vercel project
3. Add the 3 environment variables above in Vercel → Settings → Environment Variables
4. Deploy — your URL will be `foldifycase-warehouse.vercel.app`
5. Add `warehouse.html` to the repo root — Vercel serves it automatically
