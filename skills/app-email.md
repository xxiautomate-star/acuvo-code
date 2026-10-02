---
name: app-email
description: Email the app's OWNER from a generated app — a contact form, an enquiry, an order alert — with AcuvoEmail.send from the page or ctx.email.send from a server function. It cannot email anyone else.
---

# Email to the owner

"A contact form that emails me" is the commonest backend ask there is. The
runtime injects `window.AcuvoEmail` on every surface; one call delivers to
the owner's inbox through the platform's mail sender. No keys, no setup.

## The page

```html
<form id="contact">
  <input name="name" required placeholder="Your name">
  <input name="email" type="email" required placeholder="Your email">
  <textarea name="message" required placeholder="How can we help?"></textarea>
  <button>Send</button>
  <p id="status" aria-live="polite"></p>
</form>
<script>
  const form = document.getElementById('contact');
  const status = document.getElementById('status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    status.textContent = 'Sending…';
    try {
      await AcuvoEmail.send({
        subject: `Enquiry from ${data.name}`,
        text: `${data.message}\n\nFrom: ${data.name} <${data.email}>`,
        replyTo: data.email,          // "Reply" in the owner's mail client answers the visitor
      });
      status.textContent = 'Thanks — we will be in touch.';
      form.reset();
    } catch (err) {
      status.textContent = err.code === 'rate_limited' ? 'Too many messages right now. Please try again later.' : 'Could not send. Please email us directly.';
    }
  });
</script>
```

`AcuvoEmail.send({ subject, text, html?, replyTo? })` resolves `{ ok: true }`
or throws an error whose `code` is one of `rate_limited`, `too_large`,
`bad_body`, `disabled`.

## From a server function

```js
// functions/order-placed.js
module.exports = async function (args, ctx) {
  await ctx.data.put('orders', args.id, args);
  await ctx.email.send({ subject: `Order ${args.id}`, text: `${args.qty} × ${args.item} for ${args.customer}` });
  return { ok: true };
};
```

## The rules the door enforces

- **The recipient is always the owner.** There is no `to` field. A visitor
  can write to the owner and cannot use the app to write to anyone else.
  Order confirmations to customers and newsletters are not this door; say
  so in the page rather than pretending.
- Subject at most 200 characters, text 10 KB, html 32 KB.
- 20 messages per app per day, 5 per visitor per hour, and a platform-wide
  daily cap. Show the `rate_limited` case in the page, as above.
- The subject arrives prefixed with the project's name; the sender reads
  `<project> via Acuvo`.
