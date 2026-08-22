---
name: forms-and-validation
description: Building a form that actually works — validation timing, error copy, and the states people forget
when: Whenever the thing you are building contains an input, a form, or a submit button
---

# Forms

The most common thing a generated app contains, and the most commonly half-built.

## The four states every form has

A form is not "empty" and "filled". It is:

1. **empty** — nothing typed, no errors shown yet
2. **invalid** — the user has been told what is wrong, in words
3. **submitting** — the button is disabled and says so
4. **done** — the user can see it worked

Skipping 3 is how a form gets double-submitted. Skipping 4 is how a user fills
it in twice because nothing appeared to happen.

## ⚠️ Validation timing is the difference between helpful and hostile

- **Do not validate while the user is still typing the first time.** Turning a
  field red at the third character of an email address is punishing someone for
  not having finished.
- **Validate on blur**, and again on submit.
- **Once a field has errored, re-validate as they type** — so the error clears
  the moment they fix it, rather than after they leave the field again.

## Error messages say what to do

```
✗ "Invalid input"
✗ "Error: field required"
✓ "Enter an email address — we send the confirmation there"
✓ "Password needs 8 characters or more"
```

Put the message next to the field, not in a banner at the top. A banner cannot
say *which* of nine fields is wrong.

## ⚠️⚠️ Never trust the client

Client validation is a convenience for the user. It is not a check. Anything
that matters is validated again on the server, because the client is a program
the user controls.

Marking a field `required` in HTML and nowhere else means the first person to
open devtools sends whatever they like.

## Accessibility, which is three attributes

```html
<label for="email">Email</label>
<input id="email" name="email" type="email" aria-describedby="email-error">
<p id="email-error" role="alert">Enter an email address</p>
```

A placeholder is not a label — it disappears exactly when the user needs it,
and screen readers do not reliably announce it.

## Use the right input type

`type="email"`, `type="tel"`, `type="number"`, `inputmode="numeric"`. On a
phone this changes the keyboard that appears, which is a real difference in
whether the form gets completed.

## The submit handler

```js
form.addEventListener('submit', async (e) => {
  e.preventDefault();              // or the page reloads and the work is lost
  if (busy) return;                 // guard the double-click
  busy = true;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await save(new FormData(form));
    showSuccess();
  } catch (err) {
    showError(err);                 // tell the user, do not swallow it
  } finally {
    busy = false;                   // ⚠️ in finally, or one failure freezes the form forever
    button.disabled = false;
    button.textContent = 'Save';
  }
});
```

⚠️ The `finally` is the part that gets left out. Without it, a single failed
request leaves the button disabled and the user with no way to retry.
