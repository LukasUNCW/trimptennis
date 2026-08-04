# Switching QuickBooks from sandbox to the academy's real books

Status: **not started.** Written 2026-08-04. Everything below is blocked on two
answers from Katie, listed under Prerequisites.

The integration is built, tested end to end, and deployed. It is pointed at a
sandbox company, and two guards keyed off `QBO_SANDBOX` keep it there. This
document is the procedure for removing them.

Read `docs/QBO-INTEGRATION.md` first for what the integration does and why the
customer model is what it is.

## The risk, stated plainly

Money. Specifically, **the same enrolment being paid for twice.**

Every fallback in `bookInQuickBooks` exists to prevent one thing: a parent
holding both an invoice and a working static payment link. During the switch
both routes are briefly plausible, which is why the static links do not get
retired until a real payment has been watched all the way through, and why
nothing here happens in a different order to save time.

Second risk, smaller but easy to cause: **revenue booked to the wrong income
account.** That is Katie's answer to give, not ours to infer, and it is why
`/qbo/seed-items` refuses to run outside sandbox.

## Prerequisites

Both from Katie. Neither has a workaround.

1. **Which income account should program revenue book to.** Without it there is
   nowhere correct to create the seven Items.
2. **Katie at a keyboard, signed in as QuickBooks admin.** The authorization
   grants access to her company file, so it cannot be done on her behalf.

Also worth having, though neither blocks:

3. Which QuickBooks plan the academy is on. Only Plus has been tested. The app
   uses nothing plan-specific, so this is a confirmation rather than a
   dependency.
4. Whether any program needs sales tax. Our invoices apply none, which matches
   what the payment links already do, so a No changes nothing.

## Procedure

Steps 1 to 3 are one unit. Production credentials pointed at the sandbox API
base do not fail cleanly, they break the working connection, so do not set the
secrets and then go to lunch.

**1. Set the production credentials.**

```
npx wrangler secret put QBO_CLIENT_ID
npx wrangler secret put QBO_CLIENT_SECRET
```

These are the **production** keys from developer.intuit.com, not the development
pair. Development keys only work against sandbox.

**2. Flip the flag.** `QBO_SANDBOX` to `"false"` in `wrangler.jsonc`.

**3. Deploy.** `npm run deploy`, which runs the catalog checks first.

**4. Katie authorizes.** Send her `/qbo/connect?key=ADMIN_KEY`. She should land
on a page reading "QuickBooks connected." Confirm the company on Intuit's
consent screen is the academy's real one and not a sandbox.

**5. Create the Items, then verify.**

```
/qbo/seed-items?key=ADMIN_KEY&account=<the account Katie named>
/qbo/verify-items?key=ADMIN_KEY
```

`seed-items` is fenced to sandbox and **will refuse to run here.** That fence is
deliberate: it writes to a chart of accounts. Either lift it for one deploy with
the account name known and correct, or have Katie create the seven Items by hand
from the list in `worker/programs.ts`. Do not lift the fence and leave it lifted.

`verify-items` must return `"ok": true` with `missing` empty before going
further. Item names are per company file, so a pass against the sandbox proves
nothing here.

**6. One real enrolment, paid with a real card.** Not a test address. Watch:

- the invoice appears in QuickBooks against the right customer and Item
- the parent lands on a working `connect.intuit.com` page, not `comingSoonview`
- the payment applies **to that invoice**, and does not appear as a separate
  unattached payment
- `qbo_customer_id` and `qbo_invoice_id` are populated on the enrolment row
- the office email reads "Invoice raised in QuickBooks", not "TEST MODE"

Refund it afterwards if the academy would rather not keep it.

**7. Remove the sandbox scaffolding.** Both are commented as such in
`worker/index.ts`:

- the `QBO_SANDBOX === 'true'` branch in `bookInQuickBooks` that returns the
  static link instead of the invoice pay link
- the `+qbotest` marker that decides whether a parent's details reach QuickBooks
  at all

Also delete `/qbo/test-fallback`. It writes records and has served its purpose.

**8. Retire the static payment links.** Only after step 6 has been watched
end to end. Set every `payUrl` to `null` in `worker/programs.ts`, run
`npm run check:programs`, deploy, and tell Katie the links can be deleted in
QuickBooks.

Leaving them in place is not harmless. Once invoices are live, a parent reaching
a static link pays an amount that applies to no invoice, which is the exact
problem this project set out to remove.

## Verifying afterwards

- A second enrolment from the same parent email reuses the existing Customer
  rather than creating a duplicate.
- An enrolment for a second child on the same account produces a second invoice
  under the same Customer, with the child's name on the line.
- Sales by Product/Service in QuickBooks shows revenue split across the seven
  Items.

## Rollback

Set `QBO_SANDBOX` back to `"true"` and deploy. Enrolments immediately stop
writing to the academy's books and revert to the static links, provided step 8
has not been done yet.

**After step 8 there is no quick rollback**, because the static links are gone
from the catalog. That asymmetry is the reason step 8 is last and gated on a
watched payment, rather than done at the same time as the flag.

Invoices already created stay in QuickBooks and are unaffected either way.

## Still open, and not part of this

- **Nothing tells the site when an invoice is paid.** `payment_status` stays
  `awaiting_payment` and `qbo_payment_id` stays null, exactly as before this
  work. An Intuit webhook is the proper fix and would let the account page show
  a parent their real status.
- **Auto-draft for the Elite and Shredder's monthly options** is still set up by
  hand in QuickBooks after the first month. Unchanged by any of this.
- **The Intuit app's host domain and redirect URIs** point at the workers.dev
  host. See `docs/DNS-CUTOVER.md`.
