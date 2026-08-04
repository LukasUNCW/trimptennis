# QuickBooks accounting integration — scope

Status: **decided, not built.** Written 2026-08-03.

Today the site takes money through static QuickBooks payment links and writes
nothing to QuickBooks accounting. This document sets out what replaces that and
why the customer model was chosen the way it was.

## The problem

A payment link carries its amount inside the URL, so the site cannot tell
QuickBooks anything about the sale — not the parent, not the player, not the
program. See the header of `worker/programs.ts`. A parent pays, and QuickBooks
Payments records an anonymous amount with no Customer, Invoice or Sales Receipt
behind it. The office then has a transaction it cannot attribute.

Observed live: a $35 Shredder's drop-in landed as a bare $35 with no customer.

## The shape

```
Enrollment → find-or-create Customer → create Invoice (Item + amount)
          → send the parent to THAT invoice's QuickBooks pay page
```

The parent still pays on Intuit's hosted page. Card details still never touch
this site, and that is not negotiable — charging the card ourselves through the
Payments API would pull card data into scope and bring PCI obligations with it,
in exchange for nothing the invoice route does not already give.

Because the payment applies to an invoice that already exists, the money is
recorded once. Creating a Sales Receipt *alongside* a payment QuickBooks has
already recorded is the way this goes wrong: the same $35 lands twice, which is
worse than an anonymous payment, because it is wrong rather than merely
unhelpful.

This also retires the static links, and with them the risk `worker/programs.ts`
documents at length — nine URLs pasted by hand, where the same link on two price
options silently charges a parent the wrong amount and no automated check can
catch it.

## The customer is the parent

Flat. No sub-customers. The player's name goes on the invoice line:

```
Katie Tolchin
  Shredder's Drop-in — Test (9-16)     $35
```

| Considered | Decision | Reason |
|---|---|---|
| Parent as customer | **Chosen** | A QuickBooks customer is whoever owes and pays money. That is the parent. |
| Player as sub-customer of the parent | **Out** | Per-child detail without the cost — the line description carries the player, the Item carries the program. Both reports work with one tier. |
| Player as customer | **Out** | Children have no AR and no email. Three siblings become three unrelated customers. |

Supporting reasons for the choice:

- **It matches the database.** `accounts` (parents) with `children` hanging off
  them, already. Find-or-create becomes a lookup on parent email — unique,
  stable, collected on every enrollment. Children have no email, so matching them
  means matching on name, which breaks on the first duplicate, nickname or typo,
  and quietly creates duplicate customers within a season.
- **Adults collapse into the same shape.** Adults enroll themselves with no
  guardian. Under sub-customers an adult would have to be their own
  sub-customer. Under flat, an adult is just a customer. One code path.
- **Sub-customers clutter.** A family of three children becomes four entries.
  Across a few hundred families that is a customer list nobody wants to scroll,
  plus a "bill with parent" toggle that quietly changes report totals.

**Revisit if** the academy ever needs separate AR per child — separate
statements, or separated parents billed for different children. QuickBooks can
convert an existing customer into a sub-customer later; un-merging a shared
history is the painful direction. Flat is the more reversible choice.

## Match on email, never on display name

QuickBooks requires Customer display names to be unique. Two "John Smith"
families collide: the second create fails, or worse, attaches to the wrong
family. The find step queries `PrimaryEmailAddr`. The name is for display only.

This is the classic bug in this integration and it is cheap to avoid up front.

## Never block a signup on Intuit

If the API is slow or down when a parent enrolls, save the enrollment, notify the
office, and show the "we'll call you to take payment" path — exactly what the
site already does for an option with no payment link. A third party's outage must
not cost a signup.

## This is not a payments app, per Intuit

Settled 2026-08-04, and written down because it cost two rejections to establish.

Getting production keys requires an app assessment questionnaire, which asks
whether the app belongs to any regulated industry. "Payments / money movement"
looks like it fits: the app's purpose is helping a parent pay the academy, and
the category's own wording says it covers apps that "automate payment
transactions between two individuals."

It does not fit, and selecting it fails the assessment. That section asks you to
certify that you hold licences to provide payment services, that you have
agreements with banks, and that you work with legal counsel on regulatory
obligations. Those are questions for a company that moves money. Answering them
honestly means certifying No, and a No there is an automatic rejection.

Intuit's own answer, from support ticket 00222863:

> If your app is not categorized as a payments or money movement app, please
> remove this selection from the General Industries section and avoid answering
> any related questions.

The app creates an invoice and hands the parent to a QuickBooks-hosted page. It
calls only the Accounting API, never the Payments API, never touches card data
and never holds funds. Intuit processes the payment for the academy under the
academy's own merchant agreement, to which this app is not a party.

So: **None of the above**, under regulated industries. Do not revisit this.

## Prerequisites, and who owns them

1. **Create an app** at developer.intuit.com and set real `QBO_CLIENT_ID` and
   `QBO_CLIENT_SECRET`. Both secrets currently exist but hold placeholder text —
   see SETUP.md. **Lukas, not Katie:** the app is independent of the company
   file, and routing a client secret through a non-technical client's inbox and
   back is worse than doing it directly. Note that this puts the app under
   Lukas's Intuit developer account — transferable later, but a dependency to
   record rather than discover.
2. **Authorize once** at `/qbo/connect?key=ADMIN_KEY`. Katie, necessarily — the
   authorization grants access to *her* company file, so she has to be the one
   signed in when she clicks Connect. Depends on step 1.
3. **Create an Item per program and price option** in QuickBooks. Without these
   there is nothing for revenue-by-program to group by. `listItems()` in
   `worker/qbo.ts` exists to confirm them. Katie's, and the only prerequisite
   that is not blocked by anything — it can start immediately.
4. Build find-or-create-customer and create-invoice against `QBO_SANDBOX=true`.
5. Verify against a real enrollment, then retire the static payment links.

## What this does not fix

- **The $35 already sitting in QuickBooks Payments.** It is processed. No deploy
  attaches it retroactively — assign it to a customer by hand.
- **Auto-draft for the Elite and Shredder's monthly options.** Still set up
  manually in QuickBooks afterwards. Unchanged by any of this.
- **Whether the payment link sale should have recorded a Sales Receipt already.**
  Worth checking Sales → All Sales in QuickBooks Online for the $35 before
  building. If a record exists but is unassigned, part of this is a settings
  problem, not a code problem.
