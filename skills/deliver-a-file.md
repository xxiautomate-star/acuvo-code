---
name: deliver-a-file
description: Handing the person a real file — CSV that opens in Excel, a calendar invite, JSON backup, a printable PDF — with Blob downloads that work in every browser
when: The deliverable is a file (export, download, invoice, ticket, calendar event, report, backup) or a button says "Download"
triggers: download, export, export csv, csv, excel, spreadsheet export, calendar invite, ics, add to calendar, pdf, print, invoice pdf, report file, backup, json export, save as file, deliver a file
version: 2
applies-to: both
---

# Deliver a file

"Download" that opens a new tab of raw text, or a CSV where every comma in an
address becomes a new column, is the commonest half-built export. The patterns
below are small and tested. Heavy PDF layout is in `printing-and-pdf`; slide
decks in `documents-and-slides`; data shaping in `csv-and-data-export`.

## The one download function

```js
function downloadFile(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);   // revoke AFTER the click has been handled
}
```

⚠️ Revoking the URL synchronously after `click()` cancels the download in some
browsers. ⚠️ The `a` must be in the document for Firefox.

## CSV that Excel opens correctly

Three rules: quote any field containing a comma, quote or newline; double the
quotes inside; and start the file with a UTF-8 BOM so Excel does not mangle
"café" into "cafÃ©". Line endings are `\r\n`.

```js
// @selftest — CSV escaping: commas, quotes, newlines, and formula injection
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                  // a cell starting with = runs as a formula in Excel
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(','));
  return '\uFEFF' + [head, ...body].join('\r\n');
}
const csv = toCsv(
  [{ name: 'Ann "The Fixer"', addr: '1 High St, Perth', note: 'line1\nline2', f: '=SUM(A1)' }],
  [{ key: 'name', label: 'Name' }, { key: 'addr', label: 'Address' }, { key: 'note', label: 'Note' }, { key: 'f', label: 'F' }],
);
assert.ok(csv.startsWith('\uFEFFName,Address,Note,F\r\n'));
assert.ok(csv.includes('"Ann ""The Fixer"""'));
assert.ok(csv.includes('"1 High St, Perth"'));
assert.ok(csv.includes('"line1\nline2"'));
assert.ok(csv.includes("'=SUM(A1)"));
```

Then: `downloadFile('bookings-2026-09-30.csv', toCsv(rows, cols), 'text/csv;charset=utf-8')`.
Date the filename — five files all called `export.csv` is how people lose data.

## A calendar invite (.ics) — one click to "Add to calendar"

```js
// @selftest — a minimal valid VEVENT, with UTC times and escaped text
function icsDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsText(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
function toIcs({ uid, start, end, title, location = '' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Acuvo//App//EN', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${icsDate(new Date(start))}`, `DTSTART:${icsDate(new Date(start))}`, `DTEND:${icsDate(new Date(end))}`,
    `SUMMARY:${icsText(title)}`, `LOCATION:${icsText(location)}`, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}
const ics = toIcs({ uid: 'b-42@app', start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z', title: 'Haircut; wash, cut', location: 'Shop 2, Main St' });
assert.ok(ics.includes('DTSTART:20261001T090000Z'));
assert.ok(ics.includes('SUMMARY:Haircut\\; wash\\, cut'));
assert.equal(ics.split('\r\n')[0], 'BEGIN:VCALENDAR');
```

`downloadFile('booking.ics', toIcs(ev), 'text/calendar;charset=utf-8')`.

## JSON backup and restore

`downloadFile('backup.json', JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 2), 'application/json')`.
Restore with `<input type="file" accept="application/json">` → `await file.text()`
→ `JSON.parse` inside `try`, check `version`, then write through the store.

## A PDF without a library — print CSS

For an invoice or a report, a print stylesheet plus `window.print()` gives a
real, selectable PDF through the browser's own "Save as PDF":

```css
@page { size: A4; margin: 16mm; }
@media print {
  nav, button, .no-print { display: none !important; }
  body { background: #fff; color: #000; }
  .invoice { break-inside: avoid; }
}
```

⚠️ Tell the person "choose **Save as PDF** in the print dialog" beside the
button — otherwise the button reads as "print" and they do not press it.

## Before you finish

- The downloaded file opens in the app it is for (Excel / Calendar / a PDF viewer).
- Non-ASCII text survives (the BOM is there).
- The filename is dated and says what it is.
