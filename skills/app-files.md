---
name: app-files
description: Visitor UPLOADS in a generated app — an avatar, a photo attached to a ticket, a PDF on a booking, a CSV to import — stored with AcuvoFiles.upload / list / remove, on the shared or the signed-in person's private scope.
when: A visitor needs to attach or upload something to the app, or the app must list and remove what they uploaded
---

# Files — what a visitor attaches

The runtime injects `window.AcuvoFiles` on every surface. One call stores a
file in the app's own bucket and hands back a permanent URL you can put in
an `<img>` or a link, plus an id to keep in a record.

## Upload

```html
<label>Photo of the damage <input id="photo" type="file" accept="image/*"></label>
<img id="preview" hidden alt="Uploaded photo">
<p id="status" aria-live="polite"></p>
<script>
  document.getElementById('photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    status.textContent = 'Uploading…';
    try {
      const f = await AcuvoFiles.upload(file);           // { id, url, name, bytes, contentType }
      preview.src = f.url; preview.hidden = false;
      await AcuvoData.set('tickets', ticketId, { ...ticket, photoId: f.id, photoUrl: f.url });
      status.textContent = 'Attached.';
    } catch (err) {
      // bad_type, too_large, quota, rate_limited — the message says which
      status.textContent = err.message;
    }
  });
</script>
```

Drag-and-drop is the same call with `e.dataTransfer.files[0]`.

## List and remove

```js
const { items, total } = await AcuvoFiles.list();   // newest first, up to 100
await AcuvoFiles.remove(items[0].id);
```

## Private files

`AcuvoFiles.private.upload / list / remove` belong to the signed-in person
(`AcuvoAuth`), scoped by the server exactly like `AcuvoData.private`. Every
private call is refused when nobody is signed in.

## The rules the door enforces

- Types: PNG, JPEG, WebP, GIF, PDF, CSV, plain text, JSON, MP3, WAV, M4A,
  MP4, WebM. No SVG, no HTML, no executables. Show the refusal's message.
- 5 MB per file; 100 files or 50 MB per app in total. Say so near the
  control rather than letting the fourth upload fail in silence.
- The URL is public: anyone who has it can open the file. Do not put a
  secret in a file name or a file.
- Shared files can be listed and removed by anyone with the app's link,
  like the notebook; use the private scope for a person's own.

## From a server function

```js
// functions/import-contacts.js
module.exports = async function (args, ctx) {
  const { text, file } = await ctx.files.readText(args.fileId);   // CSV, plain text or JSON up to 1 MB
  const rows = text.split('\n').slice(1).filter(Boolean).map((l) => l.split(','));
  for (const [name, email] of rows) await ctx.data.put('contacts', email.trim(), { name: name.trim() });
  await ctx.files.remove(args.fileId);                              // done with it
  return { imported: rows.length, from: file.name };
};
```

`ctx.files.list()` → `{ items, total }`, `ctx.files.readText(id)` → `{ text, file }`
(text-shaped types only; images and PDFs are refused with the reason),
`ctx.files.remove(id)`. Server functions see the shared scope.
