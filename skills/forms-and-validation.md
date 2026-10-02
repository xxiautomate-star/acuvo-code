---
name: forms-and-validation
description: Forms that work — validate before you save a record, the four states, and why a plain form submit is refused
when: Whenever there is an input, form, add button, or anything that saves what a person typed
triggers: form, forms, validation, validate, input, sign up form, contact form, booking form, required field, error message, submit, email field, phone number, date field
version: 2
applies-to: both
---

# Forms

The most common thing a generated app contains, and the most commonly half-built.

## ⚠️⚠️ A plain `<form action=...>` submit is REFUSED in a generated app

The page is served under `form-action 'none'`. The browser will not post the form
anywhere — no error you wrote, no network request, nothing. `allow-forms` only
lets your own submit **handler** run.

So there is exactly one working shape: `e.preventDefault()`, validate, then write
to `AcuvoData` yourself.

```html
<form id="add"><input id="text" name="text" required><button>Add</button></form>
```

```js
const form = document.getElementById('add');
const button = form.querySelector('button');
let busy = false;

form.addEventListener('submit', async (e) => {
  e.preventDefault();                 // or the browser refuses and nothing happens
  if (busy) return;                   // guard the double-click
  const text = form.text.value.trim();
  if (!text) { showFieldError('text', 'Type something first'); return; }  // validate BEFORE the write
  busy = true;
  button.disabled = true;
  button.textContent = 'Saving…';
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  try {
    await AcuvoData.set('tasks', id, { text, done: false, at: Date.now() });
    form.reset();
    await refresh();                  // re-read and re-render; see state-management
  } catch (err) {
    showError(err.message);           // the store throws a real Error — show its message
  } finally {
    busy = false;                     // ⚠️ in finally, or one failure freezes the form forever
    button.disabled = false;
    button.textContent = 'Add';
  }
});
```

⚠️ The `finally` is the part that gets left out. Without it, a single failed
request leaves the button disabled and the user with no way to retry.

## ⚠️⚠️ WHERE DOES THE SUBMISSION GO? Answer that before you write the handler

**Measured across the shipped corpus: of 61 projects with a form that collects
something, 21 write it NOWHERE.** No store, no request, nothing. They validate
properly, disable the button properly, and then show "Thanks — we'll be in touch"
over a message that has already ceased to exist. That is worse than a broken
form: a broken form gets reported, and this one loses the customer's lead while
telling them it did not.

A real shipped page said so in its own comment:

```js
// A note is left at the counter — nowhere else to store it, so we
// acknowledge it quietly. In production this posts to the shop's inbox.
```

⚠️ **There IS somewhere else to store it.** `window.AcuvoData` is injected into
every published app, whether or not the brief ever used the word "records". A
plumber's landing page, a bakery's contact form and a booking page all have it.

⭐ **An enquiry is a record.** Name, phone, message, the service they picked, and
`at: Date.now()` — that is the whole thing the business is paying for.

```js
await AcuvoData.set('enquiries', id, { name, phone, service, message, at: Date.now() });
```

⚠️⚠️ **AND SAY THIS OUT LOUD WHEN YOU DO IT, because the store is PUBLIC.**
`state-management` is blunt about what `AcuvoData` is: *a SHARED, PUBLIC
notebook — whoever holds the app's link can read and overwrite every record.* So
the enquiries above are readable by anyone the owner sends the link to. Measured
across 84 shipped projects, **13 of the 26 apps that write to the store put a
customer's name, phone or email in it**, and none of them mentioned it.

⭐ **Store it anyway — a lost lead is worse than a readable one**, and 21 of 61
forms in that same corpus wrote the enquiry NOWHERE while telling the visitor it
sent. But do two things with it:

- **Collect the minimum.** Name and one way to reply is a lead. A date of birth,
  an address or an ID number is not, and it is not yours to leave lying about.
- **Gate the collection** with the `data/rules.json` below — that is the fix, and
  it is one file.
- **Tell the owner in your summary**, in one sentence: who can read the
  enquiries, and at which email address.

⭐⭐ **THERE IS AN OWNER-ONLY COLLECTION. USE IT — IT IS ONE FILE AND NO CODE.**
Write `data/rules.json` and the save registers it:

```json
{ "admins": ["the-owner@example.com"],
  "enquiries": { "read": "admins", "write": "public" } }
```

That is exactly a lead form: **any visitor can submit, only the owner can read.**
`public` = anyone with the app · `users` = signed in · `admins` = a signed-in
user on that list. A collection with no rule stays open, so an enquiries
collection without this line is readable by everyone holding the link.

⚠️ Put the owner's real email in `admins`, ask for it if the brief has not said,
and tell them in your summary that only that address can read the enquiries.

⚠️ **`mailto:` is a link, not a submission.** `<a href="mailto:…">` in a footer is
correct and welcome. A form that hands the message to `mailto:` is not: the owner
receives it only if that particular visitor has a mail client configured, and
receives nothing at all if they do not — and you will never find out which.

⚠️ **Do not promise delivery you did not build.** If the write fails, the `catch`
below is what stops the page lying: say it did not send and give them the phone
number. "Thanks, we'll be in touch" is a claim, and every claim on a page has to
be true.

## ⭐ Validate BEFORE the write, not after

Two reasons that are specific to this platform, not general advice:

1. `AcuvoData` keys must match `[A-Za-z0-9_-]{1,64}`. A key built from what the
   user typed (a title, an email, a date with slashes) is **rejected by the
   server**, and the user sees "Request failed" for typing an apostrophe. Slug it
   or use a generated id, and keep the raw text inside the value.
2. A write that lands is a record everyone with the link now sees. Rubbish in the
   store outlives the tab that created it.

```js
const key = String(title).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64) || String(Date.now());
```

## Optimistic add, and the rollback people forget

The store is a round trip. Waiting for it before drawing makes the app feel dead.

```js
items.unshift({ key: id, value: draft });   // draw immediately
render(items);
try {
  await AcuvoData.set('tasks', id, draft);
} catch (err) {
  items = items.filter(i => i.key !== id);  // ⚠️ PUT IT BACK — otherwise the UI lies
  render(items);
  showError('Could not save — ' + err.message);
}
```

⚠️ An optimistic update with no rollback is worse than no optimistic update: the
user sees the item, reloads tomorrow, and it is gone with no explanation.

## The four states every form has

1. **empty** — nothing typed, no errors shown yet
2. **invalid** — the user has been told what is wrong, in words
3. **submitting** — the button is disabled and says so
4. **done** — the user can see it worked

Skipping 3 is how a form gets double-submitted. Skipping 4 is how a user fills it
in twice because nothing appeared to happen.

## ⚠️ Validation timing is the difference between helpful and hostile

- **Do not validate while the user is still typing the first time.** Turning a
  field red at the third character of an email address punishes someone for not
  having finished.
- **Validate on blur**, and again on submit.
- **Once a field has errored, re-validate as they type** — so the error clears the
  moment they fix it, not after they leave the field again.
- ⚠️⚠️ **Never clear an error ON BLUR.** The blur fires on the mousedown of
  Submit; the error line vanishes, the button jumps up, and the click lands on
  nothing. Measured on a generated booking form: after one empty submit, the
  booking only saved on the second press. Clear it in `onInput`, or reserve the
  error line's height (`min-height`) so nothing moves.

## Error messages say what to do

```
✗ "Invalid input"          ✗ "Error: field required"
✓ "Enter an email address so we can get back to you"
✓ "Password needs 8 characters or more"
```

Put the message next to the field, not in a banner at the top. A banner cannot say
*which* of nine fields is wrong.

⚠️⚠️ **Never write microcopy that promises the visitor an email.** The line above
used to promise one, and a generated app cannot send a visitor anything:
`AcuvoNotify` reaches the app's OWNER and has no recipient parameter at all. A
promise that never arrives is worse than sending nothing, because the person
stops waiting for a reply. Say what actually happens — *"we will get back to
you"* — or use `AcuvoNotify` so somebody really does.

## ⚠️⚠️ Client validation is a convenience, never a check

On a real server, anything that matters is validated again server-side, because
the client is a program the user controls. Marking a field `required` in HTML and
nowhere else means the first person to open devtools sends whatever they like.

⚠️ In a generated Acuvo app there is **no server of yours to re-check**, and the
store is public. So do not build anything on the assumption that only your form
can write — see `auth-and-sessions`.

## Accessibility, which is three attributes

```html
<label for="email">Email</label>
<input id="email" name="email" type="email" aria-describedby="email-error">
<p id="email-error" role="alert">Enter an email address</p>
```

A placeholder is not a label — it disappears exactly when the user needs it, and
screen readers do not reliably announce it.

## Use the right input type

`type="email"`, `type="tel"`, `type="number"`, `inputmode="numeric"`. On a phone
this changes the keyboard that appears, which is a real difference in whether the
form gets completed.

A **rich-text** field is Quill, from the shelf (two tags, in `vendor-shelf`):

- **Quill** — read it with `quill.root.innerHTML`; `getText()` silently drops
  the formatting the user just applied. **TurndownService** turns that
  HTML into Markdown (pass the string, not the Quill instance).

## ⭐ Tested pattern — one schema, validated before the write

One description of the fields drives the check, the messages and the
`aria-invalid` state, so the three can never disagree.

```js
// @selftest — a field schema validates, trims, and returns messages that say what to do
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validate(schema, raw) {
  const value = {}, errors = {};
  for (const [name, rule] of Object.entries(schema)) {
    const v = typeof raw[name] === 'string' ? raw[name].trim() : raw[name];
    if (rule.required && (v === undefined || v === '')) { errors[name] = `Enter ${rule.label.toLowerCase()}`; continue; }
    if (v === '' || v === undefined) continue;
    if (rule.type === 'email' && !EMAIL.test(v)) errors[name] = 'Enter an email like name@example.com';
    else if (rule.type === 'number' && !Number.isFinite(Number(v))) errors[name] = `${rule.label} must be a number`;
    else if (rule.min !== undefined && Number(v) < rule.min) errors[name] = `${rule.label} must be at least ${rule.min}`;
    else if (rule.maxLength && String(v).length > rule.maxLength) errors[name] = `${rule.label} must be ${rule.maxLength} characters or fewer`;
    else value[name] = rule.type === 'number' ? Number(v) : v;
  }
  return { ok: Object.keys(errors).length === 0, value, errors };
}
const schema = {
  name: { label: 'Your name', required: true, maxLength: 80 },
  email: { label: 'Email', required: true, type: 'email' },
  guests: { label: 'Guests', type: 'number', min: 1 },
};
assert.deepEqual(validate(schema, { name: '  Ann ', email: 'ann@x.io', guests: '2' }), { ok: true, value: { name: 'Ann', email: 'ann@x.io', guests: 2 }, errors: {} });
const r = validate(schema, { name: '', email: 'ann@', guests: '0' });
assert.equal(r.ok, false);
assert.equal(r.errors.name, 'Enter your name');
assert.match(r.errors.email, /name@example\.com/);
assert.equal(r.errors.guests, 'Guests must be at least 1');
```

Wire it: on submit, `const r = validate(schema, Object.fromEntries(new FormData(form)))`;
if `!r.ok`, set `aria-invalid="true"` and the message on each field in
`r.errors`, focus the first one, and write NOTHING. Only `r.value` is saved.
