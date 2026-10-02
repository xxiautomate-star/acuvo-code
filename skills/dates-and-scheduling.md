---
name: dates-and-scheduling
description: Timezone-safe dates — the ISO slice that loses a day, month arithmetic that overflows, DST, overlap
when: Bookings, calendars, rosters, shifts, due dates, timestamps, or anything grouped or sorted by date
---

# Dates and scheduling

Every booking form, roster, shift log, invoice date, due date and "revenue by
month" chart runs through this. `Date` is the most trap-dense API in JavaScript
and the traps are all off-by-one-day, which is exactly the size of error that
ships.

## ⭐⭐ First: is it a DAY or an INSTANT?

They are different types and mixing them is the whole category of bug below.

- A **calendar day** — a booking on 21 August, a due date, a shift date. It has
  no time zone. Store it as the string `'2026-08-21'`.
- An **instant** — when a row was created, when a message was sent. Store it as
  UTC (`toISOString()`), display it in the viewer's zone.

⚠️ Putting a calendar day into a `Date` is what loses the day. Below is how.

## ⚠️⚠️ The two parses are one character apart and up to a day apart

```js
new Date('2026-08-21')        // UTC midnight → in Sydney: Fri Aug 21 2026 10:00:00 GMT+1000
                              //                in New York: Thu Aug 20 2026 20:00:00
new Date('2026-08-21T00:00')  // LOCAL midnight (no Z, no offset) → Fri Aug 21 00:00 locally
```

A bare `YYYY-MM-DD` is specified as UTC. Anything with a time and no zone is
local. If you must build a `Date` from a picked day, use the numeric
constructor: `new Date(2026, 7, 21)` — and note the month is **0-indexed**.

## ⚠️⚠️ The round trip that actually ships broken

```js
new Date(2026, 7, 21).toISOString()          // "2026-08-20T14:00:00.000Z"  in Sydney
new Date(2026, 7, 21).toISOString().slice(0,10)   // "2026-08-20"   ← wrong day
```

`toISOString()` converts to **UTC**, so slicing ten characters off it gives the
UTC day, not the user's day. Every *"the booking shows the day before"* report is
this line. Build the day string from the local parts instead:

```js
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
```

## ⚠️ Month arithmetic overflows; it does not clamp

```js
const d = new Date(2026, 0, 31);      // 31 Jan 2026
d.setMonth(d.getMonth() + 1);
d.toDateString();                     // "Tue Mar 03 2026"     ← not February
```

31 January plus one month is 31 February, which rolls into March. A monthly
invoice generated on the 31st therefore **skips February entirely**. Clamp to
the length of the target month, or use a library that already does:
`luxon.DateTime.fromISO('2026-01-31').plus({ months: 1 }).toISODate()` →
`'2026-02-28'` (verified against the vendored 3.7.2 build). Luxon is self-hosted
and its script tag is in `vendor-shelf`; the global is `luxon`.

## ⚠️ A day is not 86,400,000 milliseconds

Across a daylight-saving boundary it is 23 or 25 hours. `t + 7*86400000` on a
9am Sunday shift lands at 8am or 10am the following week — which in a roster
means a person is rostered at the wrong hour twice a year.

⭐ **Add calendar units with calendar setters**: `d.setDate(d.getDate() + 7)`
gives the same clock time next week. Reserve millisecond arithmetic for
durations that really are physical elapsed time.

## The three input elements, and what they actually give you

| element | `.value` is always | empty is |
|---|---|---|
| `<input type="date">` | `"2026-08-21"` — ISO, **regardless of the locale shown** | `""` |
| `<input type="time">` | `"14:30"` (24h; `"14:30:00"` with seconds) | `""` |
| `<input type="datetime-local">` | `"2026-08-21T14:30"` — **no zone at all** | `""` |

⚠️ `datetime-local` carries no zone, so you must decide which zone it means and
record that decision — otherwise the same booking means two different instants
to two people. And the empty value is `""`, not `null`: `new Date("")` is
`Invalid Date`, and `Invalid Date` fails silently through comparisons rather
than throwing.

```js
if (Number.isNaN(d.getTime())) { /* an invalid date is a validation error */ }
```

## When the native input is not enough — flatpickr and FullCalendar

Both are on the shelf; the tags are in `vendor-shelf` (flatpickr needs its
stylesheet too).

```js
// A BOOKING SLOT PICKER. `enable` is what <input type="date"> cannot do: show
// which days are actually free. Use `disable` for the taken ones.
flatpickr('#when', {
  inline: true, enableTime: true, minuteIncrement: 30, minDate: 'today',
  enable: ['2026-09-02', '2026-09-03', '2026-09-05'],
  onChange: ([d]) => { chosen = luxon.DateTime.fromJSDate(d).toISO(); },
});
```

- **flatpickr positions itself absolutely** against the input, so a parent with
  `overflow: hidden` clips the calendar. `inline: true` sidesteps it and is what
  a booking page wants anyway.
- **FullCalendar** needs no separate stylesheet. ⚠️ Name the view
  (`initialView: 'dayGridMonth'`) or you get a toolbar and no grid.

## Sorting and grouping

- Zero-padded `YYYY-MM-DD` strings sort correctly as strings, which is the main
  reason to store days that way. `'2026-1-5'` does not — always pad.
- Group by the **local** day string (`isoDay` above), never by
  `toISOString().slice(0,10)`, or entries near midnight land in the wrong bucket.
- Display with `Intl.DateTimeFormat`, never by concatenation — build
  `"21/08/2026"` by hand and half your users read it as 8 December.

```js
new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
new Intl.RelativeTimeFormat('en-AU', { numeric: 'auto' }).format(-2, 'day');  // "2 days ago"
```

## ⭐ Overlap — the one piece of logic every roster and booking app needs

```js
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;
```

Strict `<` on both sides, so a 9–10 shift and a 10–11 shift do **not** collide.
⚠️ Compare on one scale — epoch milliseconds, or minutes from midnight *within
the same day*. Comparing `"09:00"` strings across two different dates is the
bug that lets someone be double-booked overnight.

A shift that crosses midnight ends "before" it starts on a clock; store shifts
as two instants, or as a start plus a duration, never as two times of day.

## ⚠️ `Date.now()` on the client is the user's clock

It can be wrong, and it can be set deliberately. Anything that must be true — a
booking cutoff, an expiry, an audit timestamp — comes from the server. A
client-side timestamp is a display convenience.

## Before calling it done

- [ ] Pick a date in the picker; confirm the same day is shown in the list.
- [ ] Try it once with the machine clock in a different zone, or reason it
      through explicitly — a booking app tested only in one zone is untested.
- [ ] The 31st of a month, and 29 February, both behave.
- [ ] An empty date field is a validation message, not `Invalid Date` on screen.
- [ ] Two adjacent bookings do not report a clash; two overlapping ones do.

## A server function on a clock

`AcuvoSchedule.set(name, { every, prompt })` asks the model a question on a
schedule. `AcuvoSchedule.set(name, { every, fn })` runs one of the app's own
server functions instead, which is how a schedule chains into email, SQL, a
webhook call or an upload:

```js
// page
await AcuvoSchedule.set('nightly', { every: '1d', fn: 'digest', collection: 'orders' });

// functions/digest.js
module.exports = async function (args, ctx) {
  // args = { schedule: { name, runs, at }, rows: [{ key, value }] }  (newest 40 of the collection)
  const total = args.rows.reduce((n, r) => n + Number(r.value.total || 0), 0);
  await ctx.email.send({ subject: 'Yesterday', text: `${args.rows.length} orders, $${total.toFixed(2)}` });
  return { orders: args.rows.length, total };   // saved under AcuvoData.get('__schedule', 'nightly') → { at, result, fn }
};
```

Same limits as prompt schedules: three per app, every 15 minutes to 7 days.
One of `prompt` or `fn` is required; `fn` wins when both are given.
