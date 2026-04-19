const API_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Stripe-Signature',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: API_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/create-checkout' && request.method === 'POST') {
        return withCors(await createCheckoutSession(request, env));
      }

      if (url.pathname === '/webhook' && request.method === 'POST') {
        return withCors(await handleStripeWebhook(request, env));
      }

      if (url.pathname === '/api/listings' && request.method === 'POST') {
        return withCors(await createListing(request, env));
      }

      const listingMatch = url.pathname.match(/^\/api\/listings\/([a-z0-9-]+)$/i);
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

      return withCors(json({ error: 'Not found' }, 404));
    } catch (error) {
      return withCors(json({ error: error.message || 'Server error' }, 500));
    }
  },
};

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(API_HEADERS).forEach(([k, v]) => headers.set(k, v));
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

async function createCheckoutSession(request, env) {
  const stripeSecret = requiredEnv(env, 'STRIPE_SECRET_KEY');
  const body = await request.json().catch(() => ({}));
  const successBase = body.successUrl || `${env.SITE_BASE_URL || 'https://nagoh.xyz'}/create-listing.html`;
  const cancelBase = body.cancelUrl || `${env.SITE_BASE_URL || 'https://nagoh.xyz'}/create-listing.html?canceled=1`;
  const listingFeeCents = Number(env.LISTING_FEE_CENTS || 500);
  const currency = (env.CURRENCY || 'usd').toLowerCase();

  const form = new URLSearchParams({
    mode: 'payment',
    success_url: `${successBase}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelBase,
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(listingFeeCents),
    'line_items[0][price_data][product_data][name]': 'AppCodeMarket listing fee',
    'line_items[0][quantity]': '1',
  });

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const result = await response.json();
  if (!response.ok) return json({ error: result?.error?.message || 'Stripe checkout failed' }, 400);

  return json({ id: result.id, url: result.url });
}

async function handleStripeWebhook(request, env) {
  const stripeWebhookSecret = requiredEnv(env, 'STRIPE_WEBHOOK_SECRET');
  const signature = request.headers.get('Stripe-Signature');
  const rawBody = await request.text();

  const valid = await verifyStripeSignature(rawBody, signature, stripeWebhookSecret);
  if (!valid) return json({ error: 'Invalid Stripe signature' }, 400);

  const event = JSON.parse(rawBody);

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    if (session?.id) {
      await writeJsonFile(
        env,
        `_data/checkout-events/${session.id}.json`,
        {
          sessionId: session.id,
          eventType: event.type,
          paymentStatus: session.payment_status,
          amountTotal: session.amount_total,
          currency: session.currency,
          completedAt: new Date().toISOString(),
        },
        `Record completed listing-fee checkout ${session.id}`,
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

  const timestamp = parsed.t;
  const v1 = parsed.v1;
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const digestHex = [...new Uint8Array(signatureBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return safeEqual(digestHex, v1);
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

async function createListing(request, env) {
  const body = await request.json();
  if (!body.sessionId) return json({ error: 'sessionId is required' }, 400);

  const session = await fetchCheckoutSession(body.sessionId, env);
  if (!session || session.payment_status !== 'paid' || session.status !== 'complete') {
    return json({ error: 'Stripe session is not paid and complete' }, 400);
  }

  const sessionMarkerPath = `_data/checkout-sessions/${body.sessionId}.json`;
  const alreadyUsed = await readJsonFile(env, sessionMarkerPath).catch(() => null);
  if (alreadyUsed) return json({ error: 'This checkout session was already used' }, 400);

  const normalized = normalizeListingPayload(body);
  const idBase = slugify(normalized.title) || 'app-listing';
  const id = `${idBase}-${crypto.randomUUID().slice(0, 8)}`;
  const secret = `${crypto.randomUUID()}${crypto.randomUUID().slice(0, 8)}`;
  const secretHash = await sha256(secret);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + normalized.expiresInDays * 86400000).toISOString();

  const listing = {
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
    createdAt: now.toISOString(),
    expiresAt,
  };

  await writeJsonFile(env, `_data/listings/${id}.json`, listing, `Create listing ${id}`);
  await writeJsonFile(env, `_data/listing-secrets/${id}.json`, { secretHash }, `Store listing edit secret ${id}`);
  await writeJsonFile(env, sessionMarkerPath, { usedAt: now.toISOString(), listingId: id }, `Mark checkout ${body.sessionId} as used`);

  const siteBaseUrl = env.SITE_BASE_URL || 'https://nagoh.xyz';
  const editUrl = `${siteBaseUrl}/edit-listing.html?id=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret)}`;

  return json({ id, editUrl });
}

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

  const existing = await readJsonFile(env, `_data/listings/${listingId}.json`, true);
  const secretFile = await readJsonFile(env, `_data/listing-secrets/${listingId}.json`);
  if (!(await matchesSecret(body.secret, secretFile.secretHash))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const normalized = normalizeListingPayload(body);
  const now = new Date();
  const updated = {
    ...existing.content,
    ...normalized,
    expiresAt: new Date(now.getTime() + normalized.expiresInDays * 86400000).toISOString(),
    updatedAt: now.toISOString(),
  };

  await writeJsonFile(env, `_data/listings/${listingId}.json`, updated, `Update listing ${listingId}`, existing.sha);
  return json({ ok: true, id: listingId });
}

async function deleteListing(listingId, request, env) {
  const body = await request.json();
  if (!body.secret) return json({ error: 'secret is required' }, 400);

  const existing = await readJsonFile(env, `_data/listings/${listingId}.json`, true);
  const secretMeta = await readJsonFile(env, `_data/listing-secrets/${listingId}.json`, true);
  if (!(await matchesSecret(body.secret, secretMeta.content.secretHash))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  await deleteFile(env, `_data/listings/${listingId}.json`, existing.sha, `Delete listing ${listingId}`);
  await deleteFile(env, `_data/listing-secrets/${listingId}.json`, secretMeta.sha, `Delete listing secret ${listingId}`);
  return json({ ok: true });
}

async function matchesSecret(secret, hash) {
  return safeEqual(await sha256(secret), hash || '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchCheckoutSession(sessionId, env) {
  const stripeSecret = requiredEnv(env, 'STRIPE_SECRET_KEY');
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${stripeSecret}` },
  });
  if (!response.ok) return null;
  return response.json();
}

function githubHeaders(env) {
  const token = requiredEnv(env, 'GITHUB_TOKEN');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function githubContentUrl(env, path) {
  const owner = requiredEnv(env, 'GITHUB_OWNER');
  const repo = requiredEnv(env, 'GITHUB_REPO');
  return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
}

async function readJsonFile(env, path, includeSha = false) {
  const response = await fetch(githubContentUrl(env, path), { headers: githubHeaders(env) });
  if (!response.ok) throw new Error(`GitHub read failed for ${path}`);
  const file = await response.json();
  const raw = atob(file.content.replace(/\n/g, ''));
  const content = JSON.parse(raw);
  return includeSha ? { content, sha: file.sha } : content;
}

async function writeJsonFile(env, path, data, message, sha) {
  const payload = {
    message,
    content: btoa(JSON.stringify(data, null, 2)),
    branch: env.GITHUB_BRANCH || 'main',
  };

  if (sha) payload.sha = sha;

  const response = await fetch(githubContentUrl(env, path), {
    method: 'PUT',
    headers: githubHeaders(env),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub write failed for ${path}: ${error}`);
  }

  return response.json();
}

async function deleteFile(env, path, sha, message) {
  const response = await fetch(githubContentUrl(env, path), {
    method: 'DELETE',
    headers: githubHeaders(env),
    body: JSON.stringify({
      message,
      sha,
      branch: env.GITHUB_BRANCH || 'main',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub delete failed for ${path}: ${error}`);
  }

  return response.json();
}
