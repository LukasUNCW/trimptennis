// worker/stripe.ts
// Verifies Stripe webhook signatures with Web Crypto (no stripe npm package
// needed for v1 — we only consume webhooks; Payment Links are created in the
// Stripe dashboard).
//
// Stripe signs `${timestamp}.${rawBody}` with your endpoint's signing secret
// (whsec_...) using HMAC-SHA256, and sends it in the `stripe-signature`
// header as `t=<ts>,v1=<sig>[,v1=<sig2>...]`.

const TOLERANCE_SECONDS = 300; // reject events older than 5 minutes (replay guard)

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader) return false;

  const parts = new Map<string, string[]>();
  for (const pair of signatureHeader.split(',')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!parts.has(k)) parts.set(k, []);
    parts.get(k)!.push(v);
  }

  const timestamp = parts.get('t')?.[0];
  const candidates = parts.get('v1') ?? [];
  if (!timestamp || candidates.length === 0) return false;

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > TOLERANCE_SECONDS) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return candidates.some((sig) => timingSafeEqualHex(sig, expected));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pulls the fields we store from a checkout.session.completed event object. */
export function extractEnrollment(session: any) {
  const custom = (field: string): string | null => {
    const f = (session.custom_fields ?? []).find((c: any) => c.key === field);
    return f?.text?.value ?? f?.dropdown?.value ?? null;
  };
  return {
    id: session.id as string,
    parent_name: session.customer_details?.name ?? null,
    parent_email: session.customer_details?.email ?? null,
    player_name: custom('player_name'),
    age_group: custom('age_group'),
    program: session.metadata?.program ?? 'Unknown program',
    amount_cents: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    mode: session.mode ?? 'payment',
    stripe_customer_id: (session.customer as string) ?? null
  };
}
