# Pointing seahawkstennisacademy.com at this site

Status: **not started.** Written 2026-07-29. Zone contents below were read from the
authoritative nameserver on that date — re-check before acting, they are a
snapshot, not a guarantee.

The site is live at `trimptennis.lukas-nilsson4321.workers.dev`. Launch means the
academy's own domain resolving here instead of to their old FoundationTennis
server. **Nothing about the site moves** — it stays on Cloudflare exactly as it
is. What changes is DNS.

## The risk, stated plainly

The academy's **email lives in the same zone as their website.** Moving DNS to
Cloudflare carries their mail routing with it, and a mistake does not degrade
gracefully — `info@seahawkstennisacademy.com` simply stops receiving. For a
business whose enquiries arrive by email, that is the worst outcome available in
this project, worse than the website being down.

Two things make it sharper than usual:

- **DMARC is `p=reject`.** Mail that fails authentication is rejected outright by
  recipients, not spam-foldered.
- **No DKIM signature was found** at any of the common selectors (`default`,
  `google`, `selector1`, `k1`). That cannot rule out a custom selector, but if
  there genuinely is none, then **SPF alignment is the only thing keeping their
  outbound mail deliverable under `p=reject`**. The SPF record is load-bearing.
  Copy it character for character.

## The one idea that de-risks this

**Moving DNS and switching the website are two separate events, and should be
days apart.**

If you recreate the zone in Cloudflare *including the old server's A records*,
then switch nameservers, the result is: DNS is now served by Cloudflare, email
still flows, and **the old website still loads exactly as before.** Nothing
user-visible has changed. You can verify everything calmly.

Only later — a separate, reversible action — do you attach the Worker and flip the
site over. Do not do both on the same afternoon.

## Before anything: three things to find out

1. **Who can edit DNS at mytenniscenter?** The zone's admin contact is
   `support.mytenniscenter.com`, so a support request is the fallback if Katie has
   no panel login.
2. **Who is the registrar?** Separate question from the DNS host. Nameservers are
   changed at the *registrar*, which may or may not be mytenniscenter. Someone
   needs that login, and it is often the thing nobody can find.
3. **Is the academy ready to leave the old vendor?** Cutover makes their old site
   unreachable at that domain. That is a business decision and a billing one, not
   a technical step. Confirm they have taken anything they still want off it.

## The zone as it stands (2026-07-29)

Read from `ns1.mytenniscenter.com`. SOA serial `2025010907`, primary
`ns1.mytenniscenter.com`, admin `support.mytenniscenter.com`.

| Name | Type | Value |
|---|---|---|
| `@` | A | `52.167.12.19` |
| `www` | A | `52.167.12.19` |
| `@` | MX | `tennismail.srvr.media3.us` — **preference 10** |
| `mail` | CNAME | `tennismail.srvr.media3.us` |
| `autodiscover` | CNAME | `tennismail.srvr.media3.us` |
| `email` | CNAME | `tennismail.srvr.media3.us` |
| `@` | TXT | `v=spf1 mx a ip4:52.167.12.19 ip4:52.177.245.183 ~all` |
| `@` | TXT | `google-site-verification=CiXgQZkyMixnq-wc-bmQY9PXjEXxsf1Az67movMoy4Q` |
| `@` | TXT | `google-site-verification=3rbUDeHUB-qH7dVqDPtnF6gwh0ZVsK2P11KJnfbNvMw` |
| `@` | TXT | `google-site-verification=O6-2CfxoTX7l8deML4N0fJ86aRCWMvjHgGk6XYiYxt8` |
| `@` | TXT | `google-site-verification=goes here` |
| `_dmarc` | TXT | `v=DMARC1; p=reject; rua=mailto:postmaster@seahawkstennisacademy.com; ruf=mailto:postmaster@seahawkstennisacademy.com; pct=100` |
| `@` | NS | `ns1.mytenniscenter.com`, `ns2.mytenniscenter.com` |

Notes on that table:

- **`autodiscover` is the one most likely to be forgotten** and it is what Outlook
  uses to configure itself. Drop it and existing mail clients keep working while
  every new setup fails confusingly.
- `52.177.245.183` appears in SPF but is not an A record anywhere — a second
  sending host. Keep it.
- `google-site-verification=goes here` is a placeholder somebody pasted literally.
  **Copy it anyway.** Tidying unknown records during a migration means two
  variables when something breaks. Remove it later, separately, if ever.
- The `rua`/`ruf` DMARC reports go to `postmaster@` on this same domain, so they
  depend on the MX being right.

Only these hosts exist — `www`, `mail`, `autodiscover`, `email`, `_dmarc`. Probing
found no `webmail`, `smtp`, `imap`, `pop`, `ftp`, `cpanel`, `portal`, or others.
Probing is not enumeration, though: it can only find names you think to ask for.
**If the vendor can export the zone file, get that instead of trusting this
table.**

## Stage 0 — prepare (no user-visible change)

1. Ask the vendor for a **zone file export**. If they provide one, it supersedes
   the table above.
2. **Lower TTLs** on every record to 300 seconds, at least 24 hours before the
   switch. This is what makes rollback fast; at a 24-hour TTL a mistake is
   visible for a day.
3. Add the domain to Cloudflare as a new zone. **Do not change nameservers yet.**
   Cloudflare will scan and import what it can find.
4. Record who is on call and when. Do not schedule this for a Friday, or for a
   morning the office needs email.

## Stage 1 — rebuild the zone in Cloudflare

Work down the table above and make Cloudflare's zone match it exactly, including
the old server's A records.

- **Set every record to DNS-only (grey cloud), not proxied.** Cloudflare's scan
  tends to proxy A records by default. Proxying the old vendor's site sends its
  traffic through Cloudflare, which can break TLS or host-header handling on an
  origin that was never expecting it — and there is no reason to proxy a site you
  are about to stop using.
- MX and mail CNAMEs cannot be proxied at all. Confirm they are grey.
- Paste TXT values rather than retyping. A single altered character in SPF or
  DMARC is the whole failure mode.

## Stage 2 — verify the copy while it is still inactive

Cloudflare's nameservers will answer for the zone before the registrar points at
them, so the copy can be checked in full before it is live. Substitute the two
nameservers Cloudflare assigns you:

```powershell
$cf = "kate.ns.cloudflare.com"   # whichever Cloudflare assigns
foreach ($t in @("A","MX","TXT","NS")) { Resolve-DnsName "seahawkstennisacademy.com" -Type $t -Server $cf }
foreach ($h in @("www","mail","autodiscover","email","_dmarc")) { Resolve-DnsName "$h.seahawkstennisacademy.com" -Server $cf }
```

Compare every answer against the table. **Do not proceed on anything that does
not match**, especially MX, the SPF line, and `autodiscover`.

## Stage 3 — switch nameservers

At the **registrar**, replace `ns1`/`ns2.mytenniscenter.com` with the Cloudflare
pair. Then wait — this is the one step whose timing you do not control.

**Do not cancel anything at mytenniscenter yet.** Leaving their zone intact is the
rollback.

## Stage 4 — verify email immediately, before anything else

This is the step that matters most, and it is not a DNS check:

1. **Send a real email from outside to `info@seahawkstennisacademy.com`** and
   confirm it arrives. A correct MX record is not proof of delivery.
2. **Send one from that account to an outside address** — a Gmail address is
   ideal — and confirm it arrives and is not marked spam. In Gmail, open *Show
   original* and check `SPF: PASS` and `DMARC: PASS`. This is where a mangled SPF
   line shows up, and under `p=reject` it means outbound mail is being rejected.
3. Confirm Outlook or whatever the office uses still connects.

If any of that fails, go to Rollback. Do not continue to Stage 5 to "finish the
job" — the website can wait, their mail cannot.

## Stage 5 — attach the Worker (this is the site cutover)

A separate day, once Stage 4 has been clean for a while.

1. In Cloudflare, add a **custom domain** on the `trimptennis` Worker for both
   `seahawkstennisacademy.com` and `www.seahawkstennisacademy.com`. This replaces
   the old A records for those hostnames.
2. Wait, then confirm — and remember the edge disagrees with itself briefly, so
   poll rather than concluding:

```powershell
node -e "const u='https://seahawkstennisacademy.com';(async()=>{for(let i=0;i<6;i++){const r=await fetch(u);console.log(i,r.status,(await r.text()).includes('Seahawks Tennis Academy'));await new Promise(s=>setTimeout(s,10000));}})()"
```

3. Walk the site on the real domain: `/`, `/juniors`, `/elite`, `/adults`,
   `/contact`, `/login`, `/account`. Submit the contact form — **Turnstile already
   allows this hostname and `www.`**, so the forms should work with no change.
4. Sign in with a magic link. The link is built from the request origin, so it
   should now point at the real domain automatically — worth confirming rather
   than assuming.
5. `npm run test:links` still targets the workers.dev host. Both hosts serve the
   same Worker, so that is fine; update the constant if you want it testing the
   real domain.

## Stage 6 — Resend, now that the zone is yours

Only after Stage 4 is proven. Take the exact records from the Resend dashboard.

**Prefer a sending subdomain** (`send.seahawkstennisacademy.com`) over verifying
the root. The root already has an SPF record and **a domain may only have one** —
a second SPF TXT record makes SPF fail outright and, under `p=reject`, starts
getting their existing mail rejected. A subdomain gets its own SPF and DKIM and
leaves the root untouched, and still satisfies DMARC because relaxed alignment
counts a subdomain's DKIM as aligned with the root.

Then re-run the Stage 4 checks. Adding mail records is exactly when SPF breaks.

## Stage 7 — the configuration nobody remembers

Once Resend reports the domain verified:

1. In `wrangler.jsonc`, set `NOTIFY_EMAIL` back to
   `info@seahawkstennisacademy.com` and `FROM_EMAIL` to an address on the
   academy's domain. Remove the TEMPORARY comment.
2. `npm run deploy`.
3. Send a test enrolment and a test magic link, and confirm both arrive **at the
   academy's address**, not the personal stopgap.
4. If QuickBooks is ever connected, add `https://seahawkstennisacademy.com/qbo/callback`
   to the redirect URIs on the Intuit app — an OAuth redirect URI must match
   exactly, so the workers.dev one will not cover the new domain.

Until step 3 passes, **parent accounts still cannot ship to real parents.** That
is the whole reason this migration matters beyond vanity.

## Rollback

At the registrar, point the nameservers back at `ns1`/`ns2.mytenniscenter.com`.
Their zone is untouched, so the old configuration returns as soon as caches
expire — which is why Stage 0 lowers TTLs first.

After Stage 5, rolling back the *website* alone is easier: remove the Worker's
custom domain and restore the `@` and `www` A records to `52.167.12.19`. That
reverts the site without touching mail.

## Do not

- **Do not tidy the zone during the migration.** Not the placeholder Google
  record, not anything that looks unused. One change at a time.
- **Do not add a second SPF record.** Merge, or use a subdomain.
- **Do not point `FROM_EMAIL` at the academy's domain before Resend reports it
  verified.** Under `p=reject` a half-finished setup hard-bounces magic links,
  which is worse than today's stopgap where they at least reach one inbox.
- **Do not cancel the mytenniscenter account** until the site and mail have been
  right for a couple of weeks. It is the rollback and it is cheap insurance.
