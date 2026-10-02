---
name: payments
description: Taking money in a generated app — AcuvoPay feature-detection, whole cents, the visible pay link, recording the order, and no dead pay buttons
when: A checkout, a pay button, a deposit, a booking fee, a donation, a shop, an invoice — anything where a person hands over money
triggers: take money, take a payment, card payment, payment, checkout, pay button, stripe, deposit, booking fee, donation, shop, store checkout, buy now, invoice, cart, acuvopay, sell
version: 2
applies-to: builder
---

# Payments

Money is the one place a half-built feature is worse than none: a pay button
that does nothing loses the sale AND the trust. Totals and rounding are in
`money-and-totals`; this is the flow.

## ⭐ Feature-detect, then ask what this surface can do

`AcuvoPay` exists only when the owner has connected their own payment account,
and it can only charge on the PUBLISHED app — not in the builder preview.
Never assume either.

```js
async function payState() {
  if (!window.AcuvoPay) return { show: false };
  const m = await AcuvoPay.methods();   // { configured, available, reason, providerLabel, currency, label }
  if (!m.configured) return { show: false };                 // hide the button entirely
  if (!m.available) return { show: true, disabled: true, note: m.reason }; // e.g. preview: show THEIR sentence
  return { show: true, currency: m.currency, label: m.label };
}
```

⚠️ Print `m.reason` verbatim where the button would be. It is already a true
sentence; your own wording for "can't pay here" will be wrong somewhere.

⚠️ Do not log anything about payments on load. An app with no payments that
prints payment warnings to the console reads as broken.

## Whole cents, always

`amountMinor` is an integer number of cents. `19.99` is `1999`. Floats drift:
`0.1 + 0.2 !== 0.3`, and a total of `29.970000000000002` sent to a card network
is a refused charge.

```js
// @selftest — money is integers: parse, add, and format without float drift
function toMinor(input) {
  const m = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(String(input));
  if (!m) throw new Error(`not an amount: ${input}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
function formatMinor(minor, currency = 'AUD', locale = 'en-AU') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}
function cartTotalMinor(lines) {
  return lines.reduce((sum, l) => sum + l.unitMinor * l.qty, 0);
}
assert.equal(toMinor('19.99'), 1999);
assert.equal(toMinor('5.5'), 550);
assert.equal(toMinor('7'), 700);
assert.throws(() => toMinor('1.999'));
assert.equal(cartTotalMinor([{ unitMinor: 999, qty: 3 }, { unitMinor: 1, qty: 1 }]), 2998);
assert.equal(0.1 + 0.2 === 0.3, false);                    // why floats are banned
assert.match(formatMinor(2998), /29\.98/);
```

## The checkout — the link is VISIBLE, the popup is a bonus

```js
async function checkout(order) {
  const h = await AcuvoPay.checkout({
    amountMinor: order.totalMinor,               // integer cents
    description: `Order ${order.ref}`,
    reference: order.ref,
  });
  await AcuvoData.set('orders', order.ref, { ...order, status: 'awaiting-payment', createdAt: Date.now() });
  if (h.kind === 'instructions') return showInstructions(h.instructions, h.reference); // nothing charged automatically
  showPayLink(h.url, h.reference, h.referenceInUrl);   // selectable text AND a link
  if (h.amountMatches === false) warn('This link charges the price set by the shop, not the total shown here.');
  AcuvoPay.open(h.url);                                 // may return false (popup blocked) — the link above is how they pay
}
```

- ⭐ **Render `h.url` on the page** as a link and as selectable text. `open()`
  returns `false` wherever the browser blocks new windows.
- Show `h.reference`; when `h.referenceInUrl` is false, tell the buyer to quote it.
- **Record the order yourself** with the same reference — AcuvoPay stores nothing.
- An order reference is human-readable and unique: `ORD-` + 6 chars of
  `crypto.randomUUID()`, upper-cased.

## A reference the buyer can read out

```js
// @selftest — references are short, unambiguous and unique enough for a small shop
function orderRef(uuid) {
  return 'ORD-' + uuid.replace(/-/g, '').slice(0, 6).toUpperCase();
}
assert.equal(orderRef('3f2a9c10-aaaa-bbbb-cccc-000000000000'), 'ORD-3F2A9C');
assert.match(orderRef('0123abcd-0000-0000-0000-000000000000'), /^ORD-[0-9A-F]{6}$/);
```

## When there is no AcuvoPay

Hide the button and take the order as a request: save it, email the owner
(`AcuvoEmail.send`), and tell the person how they will be asked to pay. A
"Pay now" that cannot pay is the one thing never to ship.

## Before you finish

- No float ever reaches `amountMinor`.
- Preview shows `m.reason`; published app shows a visible link after checkout.
- The order exists in `AcuvoData` with the same reference as the payment.
- Nothing about payments is logged on page load.
