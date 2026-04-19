# AppCodeMarket

AppCodeMarket is a GitHub Pages marketplace where developers list unfinished iOS/Android app codebases. Sellers pay a Stripe listing fee first, then publish their listing with their own purchase link. Buyer payments go directly to sellers.

## Repository Structure

- `index.html` – Marketplace homepage
- `listing.html` – Single listing page
- `create-listing.html` – Create listing form (post-payment)
- `edit-listing.html` – Edit/delete listing via secret link
- `assets/css/style.css` – Shared styles
- `assets/js/main.js` – Listing fetch/render logic
- `assets/js/create.js` – Create listing + checkout flow
- `assets/js/edit.js` – Edit/delete listing flow
- `assets/icons/` – Listing icon assets
- `_data/listings/` – Listing JSON files
- `cloudflare-worker/index.js` – Webhook + API Worker
- `cloudflare-worker/wrangler.toml` – Worker config
- `.github/workflows/deploy-worker.yml` – Worker deploy pipeline
- `.github/workflows/clean-expired.yml` – Daily expiry cleanup

## 1) GitHub Pages Setup (nagoh.xyz)

1. In repository **Settings → Pages**, choose branch `main` and root `/`.
2. Create/confirm `CNAME` file contains `nagoh.xyz`.
3. In your DNS provider, set `nagoh.xyz` CNAME to `YOUR_USERNAME.github.io`.
4. If using Cloudflare DNS, keep DNS records proxied as desired.

## 2) Cloudflare Worker Setup

1. Create a Worker and connect this repo or deploy through GitHub Actions.
2. In Cloudflare Worker secrets, set:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `GITHUB_TOKEN` (fine-grained PAT with **Contents read/write**, **Metadata read**)
3. In Worker vars (`wrangler.toml`/dashboard), set:
   - `GITHUB_OWNER` (default: `NAGOHUSA`)
   - `GITHUB_REPO` (default: `N.A.G.O.H`)
   - `GITHUB_BRANCH` (default: `main`)
   - `SITE_BASE_URL` (default: `https://nagoh.xyz`)
   - `LISTING_FEE_CENTS` (default: `500`)
   - `CURRENCY` (default: `usd`)

## 3) Stripe Setup

1. In Stripe Dashboard, create a webhook endpoint:
   - `https://YOUR_WORKER.workers.dev/webhook`
2. Enable event:
   - `checkout.session.completed`
3. Copy webhook signing secret to `STRIPE_WEBHOOK_SECRET`.

## 4) Frontend ↔ Worker Binding

The frontend calls Worker APIs using `window.APP_CODE_MARKET_WORKER_BASE`.

Add this in each HTML file before JS script tags if Worker is on another origin:

```html
<script>
  window.APP_CODE_MARKET_WORKER_BASE = 'https://YOUR_WORKER.workers.dev';
</script>
```

If Worker is proxied on same domain/path, leave it empty.

## 5) GitHub Actions Secrets/Variables

Set repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `APP_CODE_MARKET_GITHUB_TOKEN`

Optional repository variables:

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH`
- `SITE_BASE_URL`
- `LISTING_FEE_CENTS`
- `CURRENCY`

## 6) Listing Creation Flow

1. Seller opens `create-listing.html`.
2. Clicks **Pay listing fee**.
3. Worker creates Stripe Checkout session (`POST /api/create-checkout`).
4. Stripe redirects back with `?session_id=...`.
5. Seller submits listing form.
6. Worker validates Stripe session, writes listing JSON to `_data/listings/`, and returns a secret edit URL.

## 7) Edit/Delete Flow

- Secret edit link format:
  - `https://nagoh.xyz/edit-listing.html?id=LISTING_ID&secret=SECRET_TOKEN`
- Edit page loads listing through Worker (`GET /api/listings/:id?secret=...`).
- Updates via `PUT /api/listings/:id`.
- Deletion via `DELETE /api/listings/:id`.

## 8) Expiration Cleanup

- `clean-expired.yml` runs daily.
- Removes expired JSON files in `_data/listings/`.
- Commits and pushes deletions automatically.

## 9) Stripe Test Mode Instructions

1. Use Stripe **Test mode** keys and webhook secret.
2. Use test card `4242 4242 4242 4242`, any valid future date/CVC.
3. Complete checkout from `create-listing.html`.
4. Confirm:
   - Webhook receives `checkout.session.completed`
   - Listing creation succeeds with returned edit URL
   - New JSON appears in `_data/listings/`

## Security Notes

- Secret edit tokens are returned once at listing creation.
- Worker stores only SHA-256 hash of secret token in `_data/listing-secrets/`.
- Site owner does not process buyer-seller app purchase payments.
