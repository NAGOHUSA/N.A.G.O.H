// alerts.nagoh.xyz/* — Cloudflare Worker
//
// Routes handled:
//   GET  /health                            Health check
//   POST /webhook                           Stripe payment-link webhook (no STRIPE_SECRET_KEY needed)
//   POST /v1/push/:token                    Apple App Store Server Notification receiver
//   GET  /api/listings                      List approved listings
//   POST /api/listings                      Submit listing (payment verified via webhook record)
//   GET  /api/listings/:id?secret=…         Get listing (requires secret)
//   PUT  /api/listings/:id                  Update listing (requires secret)
//   DELETE /api/listings/:id               Delete listing (admin key or secret)
//   GET  /api/submissions                   List submissions (admin)
//   POST /api/submissions/:id/approve       Approve submission (admin)
//   POST /api/submissions/:id/reject        Reject submission (admin)
//
// Required secrets (wrangler secret put …):
//   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (no Stripe API key needed)
//   ADMIN_KEY              — arbitrary secret for admin endpoints
//
// Required KV namespace (wrangler.toml [[kv_namespaces]]):
//   LISTINGS               — KV binding for all listings, submissions, sessions, secrets
//
// Required vars (wrangler.toml [vars]):
//   SITE_BASE_URL

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Stripe-Signature,X-Admin-Key',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // Health check
      if (pathname === '/health' && request.method === 'GET') {
        return withCors(json({ ok: true, service: 'alerts.nagoh.xyz', ts: new Date().toISOString() }));
      }

      // Stripe payment-link webhook (records paid sessions; no Stripe API call needed)
      if (pathname === '/webhook' && request.method === 'POST') {
        return withCors(await handleStripeWebhook(request, env));
      }

      // Apple App Store Server Notifications
      const pushMatch = pathname.match(/^\/v1\/push\/(.+)$/);
      if (pushMatch && request.method === 'POST') {
        return withCors(await handleApplePush(pushMatch[1], request, env));
      }

      // Listings
      if (pathname === '/api/listings' && request.method === 'GET') {
        return withCors(await listListings(env));
      }

      if (pathname === '/api/listings' && request.method === 'POST') {
        return withCors(await createListing(request, env));
      }

      const listingMatch = pathname.match(/^\/api\/listings\/([a-z0-9-]+)$/i);
      if (listingMatch) {
        const listingId = listingMatch[1];
        if (request.method === 'GET') {
          return withCors(await getListingWithSecret(listingId, url.searchParams.get('secret'), env));
        }
        if (request.method === 'PUT') {
          return withCors(await updateListing(listingId, request, env));
        }
        if (request.method === 'DELETE') {
          return withCors(await deleteListing(listingId, request, env));
        }
      }

      // Submissions (admin)
      if (pathname === '/api/submissions' && request.method === 'GET') {
        return withCors(await listSubmissions(request, env));
      }

      const submissionActionMatch = pathname.match(/^\/api\/submissions\/([a-z0-9-]+)\/(approve|reject)$/i);
      if (submissionActionMatch && request.method === 'POST') {
        const [, submissionId, action] = submissionActionMatch;
        if (action === 'approve') {
          return withCors(await approveSubmission(submissionId, request, env));
        }
        return withCors(await rejectSubmission(submissionId, request, env));
      }

      return withCors(json({ error: 'Not found' }, 404));
    } catch (error) {
      return withCors(json({ error: error.message || 'Server error' }, 500));
    }
  },
};

// ── Core helpers ──────────────────────────────────────────────────────────────

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requiredEnv(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function validateUrl(url) {
  try {
    const value = new URL(url);
    return ['http:', 'https:'].includes(value.protocol);
  } catch {
    return false;
  }
}

function validateEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''));
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function matchesSecret(secret, hash) {
  return safeEqual(await sha256(secret), hash || '');
}

function verifyAdminKey(request, env) {
  const adminKey = env.ADMIN_KEY;
  if (!adminKey) return { ok: false, error: 'Admin key not configured on server' };
  const requestKey = request.headers.get('X-Admin-Key');
  if (!requestKey) return { ok: false, error: 'X-Admin-Key header required' };
  if (!safeEqual(requestKey, adminKey)) return { ok: false, error: 'Invalid admin key' };
  return { ok: true };
}

// ── Stripe webhook ────────────────────────────────────────────────────────────
// Verifies the Stripe-Signature header and records completed payment-link
// sessions so createListing can confirm payment without calling the Stripe API.

async function handleStripeWebhook(request, env) {
  const webhookSecret = requiredEnv(env, 'STRIPE_WEBHOOK_SECRET');
  const signature = request.headers.get('Stripe-Signature');
  const rawBody = await request.text();

  if (!(await verifyStripeSignature(rawBody, signature, webhookSecret))) {
    return json({ error: 'Invalid Stripe signature' }, 400);
  }

  const event = JSON.parse(rawBody);

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    if (session?.id) {
      await writeJsonFile(
        env,
        `_data/checkout-sessions/${session.id}.json`,
        {
          sessionId: session.id,
          paymentStatus: session.payment_status,
          amountTotal: session.amount_total,
          currency: session.currency,
          completedAt: new Date().toISOString(),
        },
      );
    }
  }

  return json({ received: true });
}

async function verifyStripeSignature(payload, stripeSignatureHeader, webhookSecret) {
  if (!stripeSignatureHeader) return false;

  const parsed = Object.fromEntries(
    stripeSignatureHeader
      .split(',')
      .map((part) => part.split('='))
      .filter(([k, v]) => k && v),
  );

  const { t, v1 } = parsed;
  if (!t || !v1) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const digestHex = [...new Uint8Array(signatureBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return safeEqual(digestHex, v1);
}

// ── Apple App Store Server Notifications ─────────────────────────────────────
// Receives Apple JWS notifications, decodes them, and persists to GitHub
// so you can audit subscription events from the dashboard.

async function handleApplePush(token, request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { signedPayload } = body || {};
  if (!signedPayload || typeof signedPayload !== 'string') {
    return json({ error: 'signedPayload is required' }, 400);
  }

  // Apple JWS format: header.payload.signature — decode the middle part
  const parts = signedPayload.split('.');
  if (parts.length < 2) return json({ error: 'Malformed signedPayload' }, 400);

  let notification;
  try {
    notification = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return json({ error: 'Could not decode notification payload: invalid base64 encoding or malformed JSON' }, 400);
  }

  const notificationType = notification.notificationType || 'UNKNOWN';
  const subtype = notification.subtype || '';

  // Decode signed transaction info if present (non-fatal if it fails)
  let transactionInfo = null;
  const txJws = notification.data?.signedTransactionInfo;
  if (txJws && typeof txJws === 'string') {
    try {
      const txParts = txJws.split('.');
      if (txParts.length >= 2) {
        transactionInfo = JSON.parse(atob(txParts[1].replace(/-/g, '+').replace(/_/g, '/')));
      }
    } catch {
      // non-fatal
    }
  }

  const record = {
    token,
    notificationType,
    subtype,
    transactionInfo,
    rawNotification: notification,
    receivedAt: new Date().toISOString(),
  };

  // Persist to GitHub for audit (non-fatal if GitHub write fails)
  const id = crypto.randomUUID();
  await writeJsonFile(
    env,
    `_data/apple-notifications/${id}.json`,
    record,
  ).catch(() => {});

  return json({ received: true, message: 'Notification Sent!', notificationType, subtype });
}

// ── Listing validation ────────────────────────────────────────────────────────

function normalizeListingPayload(payload) {
  const priceUsd = Number(payload.priceUsd);
  const expiresInDays = Math.max(1, Math.min(90, Number(payload.expiresInDays || 30)));

  if (!payload.title || !payload.description) throw new Error('title and description are required');
  if (!validateUrl(payload.repoUrl)) throw new Error('repoUrl must be a valid URL');
  if (!validateUrl(payload.sellerPaymentLink)) throw new Error('sellerPaymentLink must be a valid URL');
  if (payload.iconUrl && !validateUrl(payload.iconUrl)) throw new Error('iconUrl must be a valid URL when provided');
  if (!validateEmail(payload.contactEmail)) throw new Error('contactEmail must be valid');
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error('priceUsd must be greater than zero');

  return {
    title: String(payload.title).trim(),
    description: String(payload.description).trim(),
    platform: String(payload.platform || 'iOS + Android').trim(),
    repoUrl: String(payload.repoUrl).trim(),
    sellerPaymentLink: String(payload.sellerPaymentLink).trim(),
    priceUsd,
    techStack: String(payload.techStack || '').trim(),
    iconUrl: String(payload.iconUrl || '').trim(),
    contactEmail: String(payload.contactEmail).trim(),
    expiresInDays,
  };
}

// ── Create listing ────────────────────────────────────────────────────────────
// Payment verification uses the webhook-recorded session file instead of
// calling the Stripe API, so no STRIPE_SECRET_KEY is required.

async function createListing(request, env) {
  const body = await request.json();
  const isTestMode = body.skipPayment === true;

  if (!isTestMode) {
    const sessionId = body.sessionId || body.paymentSessionId;
    if (!sessionId) {
      return json({ error: 'sessionId is required — complete the Stripe payment link first' }, 400);
    }

    // Verify payment was recorded by the /webhook handler (no Stripe API call)
    const sessionRecord = await readJsonFile(env, `_data/checkout-sessions/${sessionId}.json`).catch(() => null);
    if (!sessionRecord || sessionRecord.paymentStatus !== 'paid') {
      return json(
        { error: 'Payment not confirmed. Complete the Stripe payment link and try again.' },
        400,
      );
    }

    // Prevent a session from being used twice
    const usedPath = `_data/checkout-sessions-used/${sessionId}.json`;
    const alreadyUsed = await readJsonFile(env, usedPath).catch(() => null);
    if (alreadyUsed) return json({ error: 'This payment session has already been used' }, 400);

    await writeJsonFile(env, usedPath, { usedAt: new Date().toISOString() });
  }

  const normalized = normalizeListingPayload(body);
  const idBase = slugify(normalized.title) || 'app-listing';
  const id = `${idBase}-${crypto.randomUUID().slice(0, 8)}`;
  const secret = `${crypto.randomUUID()}${crypto.randomUUID().slice(0, 8)}`;
  const secretHash = await sha256(secret);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + normalized.expiresInDays * 86400000).toISOString();

  const submission = {
    id,
    title: normalized.title,
    description: normalized.description,
    platform: normalized.platform,
    repoUrl: normalized.repoUrl,
    sellerPaymentLink: normalized.sellerPaymentLink,
    priceUsd: normalized.priceUsd,
    techStack: normalized.techStack,
    iconUrl: normalized.iconUrl,
    contactEmail: normalized.contactEmail,
    submittedAt: now.toISOString(),
    expiresAt,
    status: 'pending',
    testMode: isTestMode,
  };

  await writeJsonFile(env, `_data/submissions/${id}.json`, submission);
  await writeJsonFile(env, `_data/listing-secrets/${id}.json`, { secretHash });

  const siteBaseUrl = env.SITE_BASE_URL || 'https://nagoh.xyz';
  const editUrl = `${siteBaseUrl}/edit-listing.html?id=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret)}`;

  return json({
    success: true,
    id,
    editUrl,
    message: 'Listing submitted for review. It will appear on the marketplace once approved by an admin.',
  });
}

// ── Get / update / delete listing ────────────────────────────────────────────

async function getListingWithSecret(listingId, secret, env) {
  const file = await readJsonFile(env, `_data/listings/${listingId}.json`);
  const secretFile = await readJsonFile(env, `_data/listing-secrets/${listingId}.json`);
  if (!secret) return json({ error: 'Missing secret' }, 400);
  if (!(await matchesSecret(secret, secretFile.secretHash))) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return json({ listing: file });
}

async function updateListing(listingId, request, env) {
  const body = await request.json();
  if (!body.secret) return json({ error: 'secret is required' }, 400);

  const existing = await readJsonFile(env, `_data/listings/${listingId}.json`);
  const secretFile = await readJsonFile(env, `_data/listing-secrets/${listingId}.json`);
  if (!(await matchesSecret(body.secret, secretFile.secretHash))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const normalized = normalizeListingPayload(body);
  const now = new Date();
  const updated = {
    ...existing,
    ...normalized,
    expiresAt: new Date(now.getTime() + normalized.expiresInDays * 86400000).toISOString(),
    updatedAt: now.toISOString(),
  };

  await writeJsonFile(env, `_data/listings/${listingId}.json`, updated);
  return json({ ok: true, id: listingId });
}

async function deleteListing(listingId, request, env) {
  const body = await request.json().catch(() => ({}));
  const adminAuth = verifyAdminKey(request, env);
  const hasAdminKey = adminAuth.ok;

  if (!hasAdminKey && !body.secret) {
    return json({ error: 'secret or X-Admin-Key header is required' }, 400);
  }

  await readJsonFile(env, `_data/listings/${listingId}.json`);

  if (!hasAdminKey) {
    const secretMeta = await readJsonFile(env, `_data/listing-secrets/${listingId}.json`);
    if (!(await matchesSecret(body.secret, secretMeta.secretHash))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    await deleteFile(env, `_data/listing-secrets/${listingId}.json`);
  }

  await deleteFile(env, `_data/listings/${listingId}.json`);
  return json({ success: true, ok: true });
}

// ── List approved listings ────────────────────────────────────────────────────

async function listListings(env) {
  try {
    const files = await listDirectory(env, '_data/listings');
    const jsonFiles = files.filter((f) => f.type === 'file' && f.name.endsWith('.json'));

    const listings = await Promise.all(
      jsonFiles.map((f) => readJsonFile(env, `_data/listings/${f.name}`).catch(() => null)),
    );

    const validListings = listings.filter(Boolean);
    return json({ success: true, listings: validListings, count: validListings.length });
  } catch (error) {
    return json({ success: false, error: error.message, listings: [], count: 0 });
  }
}

// ── Submissions (admin-only) ──────────────────────────────────────────────────

async function listSubmissions(request, env) {
  const adminAuth = verifyAdminKey(request, env);
  if (!adminAuth.ok) return json({ error: adminAuth.error }, 401);

  try {
    const files = await listDirectory(env, '_data/submissions');
    const jsonFiles = files.filter((f) => f.type === 'file' && f.name.endsWith('.json'));

    const submissions = await Promise.all(
      jsonFiles.map((f) => readJsonFile(env, `_data/submissions/${f.name}`).catch(() => null)),
    );

    const validSubmissions = submissions.filter(Boolean);
    return json({ success: true, submissions: validSubmissions, count: validSubmissions.length });
  } catch (error) {
    return json({ success: false, error: error.message, submissions: [], count: 0 });
  }
}

async function approveSubmission(submissionId, request, env) {
  const adminAuth = verifyAdminKey(request, env);
  if (!adminAuth.ok) return json({ error: adminAuth.error }, 401);

  const submissionPath = `_data/submissions/${submissionId}.json`;
  const submission = await readJsonFile(env, submissionPath);

  if (submission.status === 'approved') return json({ error: 'Submission already approved' }, 400);
  if (submission.status === 'rejected') return json({ error: 'Cannot approve a rejected submission' }, 400);

  const now = new Date();
  const listing = {
    id: submission.id,
    title: submission.title,
    description: submission.description,
    platform: submission.platform,
    repoUrl: submission.repoUrl,
    sellerPaymentLink: submission.sellerPaymentLink,
    priceUsd: submission.priceUsd,
    techStack: submission.techStack,
    iconUrl: submission.iconUrl,
    contactEmail: submission.contactEmail,
    createdAt: submission.submittedAt,
    expiresAt: submission.expiresAt,
    approvedAt: now.toISOString(),
    status: 'approved',
  };

  await writeJsonFile(env, `_data/listings/${submissionId}.json`, listing);

  const updatedSubmission = { ...submission, status: 'approved', approvedAt: now.toISOString() };
  await writeJsonFile(env, submissionPath, updatedSubmission);

  return json({ success: true, id: submissionId });
}

async function rejectSubmission(submissionId, request, env) {
  const adminAuth = verifyAdminKey(request, env);
  if (!adminAuth.ok) return json({ error: adminAuth.error }, 401);

  const submissionPath = `_data/submissions/${submissionId}.json`;
  const submission = await readJsonFile(env, submissionPath);

  if (submission.status === 'approved') return json({ error: 'Cannot reject an already approved submission' }, 400);
  if (submission.status === 'rejected') return json({ error: 'Submission already rejected' }, 400);

  const body = await request.json().catch(() => ({}));
  const now = new Date();
  const updatedSubmission = {
    ...submission,
    status: 'rejected',
    rejectedAt: now.toISOString(),
    rejectionReason: String(body.reason || '').trim() || null,
  };

  await writeJsonFile(env, submissionPath, updatedSubmission);

  return json({ success: true, id: submissionId });
}

// ── KV helpers ────────────────────────────────────────────────────────────────

const kv = (env) => env.LISTINGS;

async function readJsonFile(env, path) {
  const value = await kv(env).get(path, 'json');
  if (value === null) throw new Error(`Not found: ${path}`);
  return value;
}

async function writeJsonFile(env, path, data) {
  await kv(env).put(path, JSON.stringify(data));
}

async function deleteFile(env, path) {
  await kv(env).delete(path);
}

async function listDirectory(env, prefix) {
  const result = await kv(env).list({ prefix: `${prefix}/`, limit: 1000 });
  return result.keys.map((k) => ({
    name: k.name.slice(prefix.length + 1),
    type: 'file',
  }));
}
