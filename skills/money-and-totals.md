---
name: money-and-totals
description: Integer cents, Intl formatting and tax that reconciles — totals, GST, discounts, carts, invoices
when: Any price, total, subtotal, tax, GST, VAT, discount, cart, invoice, payroll or split-the-bill sum
---

# Money and totals

An app that gets money wrong is not a rough draft, it is a liability. And the
errors are not subtle to a customer: they are a total that does not match the
lines above it.

## ⚠️⚠️ Never hold money in a floating-point number

```js
0.1 + 0.2                       // 0.30000000000000004
[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1].reduce((a,b)=>a+b)   // 0.9999999999999999
```

⭐ **Hold integer cents.** `1999 * 3 === 5997`, exactly, forever. Convert once
when the value enters (`Math.round(Number(input) * 100)`) and once when it is
shown. Everything between is integers.

```js
const toCents = (s) => Math.round(Number(String(s).replace(/[$,\s]/g, '')) * 100);
const subtotal = items.reduce((c, i) => c + i.priceCents * i.qty, 0);
```

## ⚠️⚠️ `toFixed(2)` is not rounding you can rely on

```js
(1.005).toFixed(2)   // "1.00"   ← not "1.01"
(2.675).toFixed(2)   // "2.67"
(8.575).toFixed(2)   // "8.57"
Math.round(1.005 * 100) / 100    // 1        because 1.005 * 100 === 100.49999999999999
```

Those decimals do not exist in binary, so the value being rounded is already
slightly below the half. This is not a bug you can patch with a bigger epsilon
in a general way — it is the reason to work in cents, where there is nothing to
round at all.

## ⚠️ Empty is not zero, and a comma is not a number

```js
Number('')      // 0        an untouched input silently becomes free
Number(null)    // 0
Number('  ')    // 0
Number('5,000') // NaN      the thousands separator the user typed
Number('$20')   // NaN
```

⭐ **One `NaN` in a `reduce` makes the whole total `NaN`, and it renders as the
literal word "NaN" on the page.** Validate the field before you coerce it; show
the error at the field. See `forms-and-validation`.

## Format with `Intl`, never by hand

```js
const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
money.format(1234.5)     // "$1,234.50"
money.format(-5)         // "-$5.00"    a hand-rolled '$' + n gives "$-5"
```

- ⚠️ **The symbol comes from the LOCALE, not the currency.** The same AUD amount
  is `$1,234.50` in `en-AU` and `A$1,234.50` in `en-US`. Both are correct; pick
  the locale deliberately, and use `currencyDisplay: 'narrowSymbol'` if you want
  the bare `$` in a locale that would disambiguate.
- ⚠️ **Do not hardcode two decimal places.** `Intl` knows that JPY has none:
  `Intl.NumberFormat('ja-JP', {style:'currency', currency:'JPY'}).format(1234.5)`
  → `￥1,235`. `toFixed(2) + ' ¥'` is wrong twice.
- Store the currency **code** next to the integer. Adding two amounts of
  different currencies must be impossible, not merely unlikely.

## ⚠️⚠️ GST/VAT: inclusive or exclusive, and say which on the page

Australian GST is 10% and consumer prices are quoted **GST-inclusive**. The GST
component of a $110 price is therefore:

```js
110 / 11          // 10   ✅ the tax inside a tax-inclusive price
110 * 0.10        // 11   ❌ 10% OF the inclusive price is not the GST in it
```

The general forms, in cents:

```js
const gstFromInclusive = (c) => Math.round(c / 11);        // 10% inclusive
const gstOnExclusive   = (c) => Math.round(c * 0.10);      // 10% added on top
```

Label every total on the page — `Subtotal (ex GST)`, `GST 10%`, `Total (inc
GST)`. A number without that label is unusable to the person who has to enter it
into their books.

## ⭐ Round at the line, then sum. Never both, never the other way.

If the page shows a rounded amount per line, the total must be the sum of the
**displayed** amounts. Otherwise the customer adds up your own column and gets a
different answer to your total — and they are right.

```js
const lineTotal = (i) => Math.round(i.priceCents * i.qty * (1 - i.discount));  // round HERE
const total     = items.reduce((c, i) => c + lineTotal(i), 0);                 // then sum
```

Decide, and write down, whether a discount applies before or after tax. The two
give different answers and only one matches the customer's expectation.

## ⚠️ The remainder in a split is real money

$10.00 across three people is not three times $3.33. It is 334 + 333 + 333
cents. Distribute the remainder to the first `n` payers — never render three
$3.33s under a $10.00 heading.

```js
const split = (cents, n) =>
  Array.from({ length: n }, (_, i) => Math.floor(cents / n) + (i < cents % n ? 1 : 0));
split(1000, 3)   // [334, 333, 333]
```

## ⚠️ Compute the total, never store it

Our own bench names this probe *"total computed, not hardcoded"*. A total held
in state goes stale the moment a quantity changes and nothing tells you. Derive
it from the items on every render; if it is expensive, memoise the derivation —
do not cache the number.

The same goes for a cart badge, a running balance, an outstanding-invoices tile:
one source of truth, everything else derived. See `state-management`.

## Before calling it done

- [ ] No money value is stored as a float anywhere in the app.
- [ ] Empty, `0`, negative (a refund) and a very large quantity all render sanely.
- [ ] Every displayed amount goes through one formatter with one currency code.
- [ ] The lines add up to the total, checked by hand on a real example.
- [ ] Tax is labelled inclusive or exclusive, in words, next to the number.
- [ ] The total is derived, not stored.
