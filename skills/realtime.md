---
name: realtime
description: Live messages between the visitors of one generated app — AcuvoLive.join(channel, onMessage) and room.send(payload) — for chat, presence, shared boards and multiplayer turns, plus ctx.live.send from a server function to wake a page.
when: The brief needs people using the app at the same time to see each other — a chat, a shared board, "who is online", a game turn, a job telling the page it finished.
---

# Realtime between visitors

`AcuvoData.watch` tells a page when a RECORD changed. This is for messages
that are not records: a chat line, a cursor, "Jo joined", "your export is
ready". They reach everyone in a channel within a second and vanish after
five minutes.

```js
const room = AcuvoLive.join('lobby', (msg) => {
  // msg: { id, channel, payload, sender, at }  — sender is 'u:…' for a signed-in person, 'v:…' for a visitor
  render(msg);
});
await room.send({ text: 'hello', name });   // everyone in 'lobby', including this tab
room.leave();                                // on unmount
```

From a server function or a background job:

```js
await ctx.live.send('exports', { jobId: args.job.id, ready: true });
```

The transport is server-sent events. Reconnection is automatic and nothing in
the last five minutes is missed across a gap. Under the hood each open channel
polls a small ring once a second and closes after four minutes, and the
browser reopens it; the app never sees that.

## Rules

- **Persist what matters, in `AcuvoData`.** A message is ephemeral. A chat
  the person should see tomorrow is a record first and a live message second.
- **One channel per room, named plainly:** `lobby`, `game:42`, `board:main`.
  Letters, digits, `_ . : -`, up to 64 characters. Never a secret in a name.
- **Small payloads, often is fine.** Under 4 KB each; a visitor may send 60 a
  minute, an app 600. A cursor at 10 a second is too many: throttle to 4.
- **Presence is a heartbeat.** Send `{ presence: name }` every 20 s and treat
  a sender silent for 60 s as gone. There is no server-side member list.
- **Trust nothing in a payload.** It came from another visitor. Escape it
  before it reaches the DOM; validate a game move before applying it; the
  `sender` field is the only part the server wrote.
- **Show connection honestly.** `join` throws in a browser without
  EventSource; catch it and fall back to `AcuvoData.watch` or a refresh.

## A minimal chat

```js
const me = (await AcuvoAuth.me().catch(() => null))?.email || 'guest';
const room = AcuvoLive.join('chat', (m) => addLine(m.payload.name, m.payload.text));
form.onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim(); if (!text) return;
  await AcuvoData.set('messages', String(Date.now()), { name: me, text });   // persists
  await room.send({ name: me, text });                                       // arrives now
  input.value = '';
};
```
