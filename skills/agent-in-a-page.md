---
name: agent-in-a-page
description: Building a chat agent as an artifact — a page whose whole job is the conversation, powered by AcuvoAI.chat with a persona, publishable at /s/<slug> and embeddable on any site with one script tag
when: The brief asks for a chatbot, support agent, booking assistant, FAQ bot, concierge, live chat or "an agent for my website" — a conversation the visitor has, not a page they read
---

# An agent in a page

An agent is a page whose whole job is the conversation. The brain is already there: every
generated page has `window.AcuvoAI` injected by the platform. You write the persona, the
conversation UI and the guardrails. You never write an API key, a model name or a fetch to a
model — `AcuvoAI.chat` is the one call.

## The shape

```html
<header>Mia · the booking assistant for Pinegrove Dental</header>
<main id="log" aria-live="polite"></main>
<form id="ask"><input autofocus placeholder="Ask about appointments…"><button>Send</button></form>
```

```js
const SYSTEM = `You are Mia, the booking assistant for Pinegrove Dental (Sydney).
You help visitors book a check-up or clean. You may ask for name, mobile and a preferred day.
You never invent availability or prices; if unsure say you'll have the practice confirm.
Warm, brief, Australian English. Never mention that you are an AI model.`;

const history = [];                         // the WHOLE conversation, oldest first
async function send(text) {
  history.push({ role: 'user', content: text });
  render(); showTyping(true);
  try {
    const reply = await AcuvoAI.chat(history, { system: SYSTEM });   // windowed for you
    history.push({ role: 'assistant', content: reply });
  } catch (err) {
    history.push({ role: 'assistant', content: err.code === 'daily_cap'
      ? 'I have reached my daily limit — please call us directly.'
      : 'Sorry, I could not answer just now. Try again in a moment.' });
  }
  showTyping(false); render();
}
```

Pass the whole history every time. The platform windows it so the prompt prefix stays stable
and cached; slicing it yourself costs money and memory.

## Rules that make it an agent rather than a toy

- **The persona is in `system`, written from the brief**: who it is, what it may do, what it
  must never do, the tone. Put the name in the header so the visitor knows who they are
  talking to.
- **Never invent facts** — no availability, prices, order status or policies the brief did not
  give you. Say what you will do instead ("I'll have someone confirm").
- **Collect, confirm, then act.** If the brief asks the agent to book, capture a lead or look
  something up, gather the fields in the conversation and read them back before acting.
  Acting = `AcuvoData` (save the lead), `AcuvoConnections` (calendar, email) or
  `AcuvoSchedule` (a follow-up), each only when the brief asks.
- **Errors are sentences**, never a blank bubble: `err.code` is one of `rate_limited`,
  `daily_cap`, `disabled` — branch on it.
- **Plain text replies.** Render the reply as text; do not inject it as HTML.

## It will be embedded

The published agent is framed on the customer's site at 400×640 by the widget loader
(`<script src="/s/<slug>/widget.js" async></script>`). So:

- fluid layout, no fixed widths, the input pinned to the bottom, the log scrolling;
- 44px tap targets, no hover-only affordances, correct on a phone full-screen too;
- a typing indicator, focus kept in the input, scroll to the newest message.

## Three suggested questions

Above the input, offer three chips written for THIS business ("When are you open?",
"Do you bulk bill?", "Book a clean"). A tap sends the question. It is the difference between a
visitor typing nothing and a visitor starting.

## Stream the reply as it is written

The same call, with `onDelta`, types the answer into the page as the model
produces it — the difference between a chat that feels alive and one that
freezes for five seconds:

```js
const bubble = addBubble('assistant', '');
const reply = await AcuvoAI.chat(history, {
  system: SYSTEM,
  onDelta: (chunk, soFar) => { bubble.textContent = soFar; scrollToBottom(); },
});
history.push({ role: 'assistant', content: reply });   // resolves with the whole reply, as before
```

Errors arrive the same way as the plain call (`err.code` = `daily_cap`,
`rate_limited`, `engine_unavailable`). Keep the bubble; replace its text with
the one-line explanation.
