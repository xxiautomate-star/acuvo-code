---
name: third-party-apis
description: Call a named third-party API from a generated app — OpenAI, Stripe, ElevenLabs, Notion, Telegram, weather, maps, search and more — through AcuvoProxy.fetch, with the owner's key injected on the server or no key at all for public data.
when: The brief wants live data or a service the app does not own — a model, payments, voice, a spreadsheet, a chat message, weather, rates, maps, search.
---

# Third-party APIs

A generated page runs under a content-security policy that names our own
doors only. **A plain `fetch('https://api.example.com')` from the page dies
silently**, whether or not the API needs a key. Every outside call goes
through the proxy, by the connector's NAME:

```js
const res = await AcuvoProxy.fetch('openweather', 'https://api.openweathermap.org/data/2.5/weather?q=Sydney&units=metric');
const data = await res.json();
```

The key never appears in the code. The owner stores it once under that name
in the workspace's API keys door; the server injects it the way that API
expects (a header, a `?key=` parameter, or a segment of the URL). Keyless
public APIs need nothing stored: name them and call. Inside a server function
the same call is `ctx.proxy.fetch(name, url, init)` and returns `{ status, body }`.

Rules the proxy enforces: HTTPS only, the host must be on the connector's
list, at most 256 KB out and 1 MB back, 10 seconds, no redirects followed.
Pass `headers` only for content-type, accept, and version pins
(`anthropic-version`, `notion-version`, `stripe-version`). A refusal rejects
with an Error whose `.code` names why (`unknown_secret`, `host_not_allowed`,
`rate_limited`). Handle it: show the person a sentence, never a blank.

## Models

| name | call |
|---|---|
| openai | `AcuvoProxy.fetch('openai', 'https://api.openai.com/v1/chat/completions', { method: 'POST', body: { model: 'gpt-4o-mini', messages } })` |
| anthropic | `AcuvoProxy.fetch('anthropic', 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'anthropic-version': '2023-06-01' }, body: { model, max_tokens: 1024, messages } })` |
| gemini | `AcuvoProxy.fetch('gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', { method: 'POST', body: { contents: [{ parts: [{ text }] }] } })` |
| groq | `AcuvoProxy.fetch('groq', 'https://api.groq.com/openai/v1/chat/completions', { method: 'POST', body: { model: 'llama-3.3-70b-versatile', messages } })` |
| openrouter | `AcuvoProxy.fetch('openrouter', 'https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: { model, messages } })` |
| deepseek | `AcuvoProxy.fetch('deepseek', 'https://api.deepseek.com/chat/completions', { method: 'POST', body: { model: 'deepseek-chat', messages } })` |
| huggingface | `AcuvoProxy.fetch('huggingface', 'https://router.huggingface.co/hf-inference/models/<model>', { method: 'POST', body: { inputs } })` |

Stream nothing through the proxy; ask for the whole answer and render it.
For an assistant that answers from the app's own content, prefer the
built-in `AcuvoAI` (no key, metered on the platform) over any of these.

## Voice and media

| name | call |
|---|---|
| elevenlabs | `AcuvoProxy.fetch('elevenlabs', 'https://api.elevenlabs.io/v1/text-to-speech/<voiceId>', { method: 'POST', body: { text } }) → audio bytes` |
| fal | `AcuvoProxy.fetch('fal', 'https://fal.run/fal-ai/flux/schnell', { method: 'POST', body: { prompt } })` |
| replicate | `AcuvoProxy.fetch('replicate', 'https://api.replicate.com/v1/predictions', { method: 'POST', body: { version, input } })` |
| unsplash | `AcuvoProxy.fetch('unsplash', 'https://api.unsplash.com/search/photos?query=' + q)` |
| pexels | `AcuvoProxy.fetch('pexels', 'https://api.pexels.com/v1/search?query=' + q)` |

Audio comes back as bytes: `const blob = await res.blob(); audio.src = URL.createObjectURL(blob)`.
For images the app will show more than once, prefer `AcuvoMedia` (ours) so
the asset is stored, not re-fetched on every visit.

## Money

| name | call |
|---|---|
| stripe | `AcuvoProxy.fetch('stripe', 'https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({...}).toString() })` |

Stripe's API is form-encoded, not JSON. Creating a Checkout Session from the
page is fine; **fulfilment must never trust the page** — put a
`functions/stripe-events.js` behind a webhook (see `app-functions`) and mark
the order paid there.

## Data and knowledge

| name | call |
|---|---|
| notion | `AcuvoProxy.fetch('notion', 'https://api.notion.com/v1/databases/<id>/query', { method: 'POST', headers: { 'notion-version': '2022-06-28' }, body: {} })` |
| airtable | `AcuvoProxy.fetch('airtable', 'https://api.airtable.com/v0/<baseId>/<table>')` |
| google-sheets | `AcuvoProxy.fetch('google-sheets', 'https://sheets.googleapis.com/v4/spreadsheets/<id>/values/Sheet1')` |
| github | `AcuvoProxy.fetch('github', 'https://api.github.com/repos/<owner>/<repo>/issues', { method: 'POST', body: { title, body } })` |
| youtube | `AcuvoProxy.fetch('youtube', 'https://www.googleapis.com/youtube/v3/search?part=snippet&q=' + q)` |

Google Sheets with an API key reads sheets shared as "anyone with the link";
writing needs OAuth, which is not offered here. Say so if the brief wants writes.

## Search and news

| name | call |
|---|---|
| brave-search | `AcuvoProxy.fetch('brave-search', 'https://api.search.brave.com/res/v1/web/search?q=' + q)` |
| tavily | `AcuvoProxy.fetch('tavily', 'https://api.tavily.com/search', { method: 'POST', body: { query } })` |
| newsapi | `AcuvoProxy.fetch('newsapi', 'https://newsapi.org/v2/top-headlines?country=au')` |

## Maps and weather

| name | call |
|---|---|
| google-maps | `AcuvoProxy.fetch('google-maps', 'https://maps.googleapis.com/maps/api/geocode/json?address=' + q)` |
| mapbox | `AcuvoProxy.fetch('mapbox', 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + q + '.json')` |
| openweather | `AcuvoProxy.fetch('openweather', 'https://api.openweathermap.org/data/2.5/weather?q=Sydney&units=metric')` |

Map tiles and the Maps JavaScript SDK are scripts, not API calls; the proxy
does not serve them. Draw a map with Leaflet from the vendor shelf and use
these for geocoding and directions data.

## Messaging

| name | call |
|---|---|
| telegram | `AcuvoProxy.fetch('telegram', 'https://api.telegram.org/bot{{secret}}/sendMessage', { method: 'POST', body: { chat_id, text } })` |
| discord | `AcuvoProxy.fetch('discord', 'https://discord.com/api/webhooks/{{secret}}', { method: 'POST', body: { content } })` |
| slack | `AcuvoProxy.fetch('slack', 'https://hooks.slack.com/services/{{secret}}', { method: 'POST', body: { text } })` |
| twilio | `AcuvoProxy.fetch('twilio', 'https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })` |

These three write `{{secret}}` literally into the URL: the door substitutes
the stored token there, once. Write it exactly like that; do not build the
URL from a key you invent. Email to the owner is not here; it is `AcuvoEmail`.

## Public data, no key

| name | call |
|---|---|
| open-meteo | `AcuvoProxy.fetch('open-meteo', 'https://api.open-meteo.com/v1/forecast?latitude=-33.87&longitude=151.21&current=temperature_2m')` |
| exchange-rates | `AcuvoProxy.fetch('exchange-rates', 'https://open.er-api.com/v6/latest/AUD')` |
| wikipedia | `AcuvoProxy.fetch('wikipedia', 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title))` |
| restcountries | `AcuvoProxy.fetch('restcountries', 'https://restcountries.com/v3.1/name/' + q)` |
| coingecko | `AcuvoProxy.fetch('coingecko', 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=aud')` |
| nominatim | `AcuvoProxy.fetch('nominatim', 'https://nominatim.openstreetmap.org/search?format=json&q=' + q)` |
| dictionary | `AcuvoProxy.fetch('dictionary', 'https://api.dictionaryapi.dev/api/v2/entries/en/' + word)` |

Open-Meteo wants coordinates: geocode the place name first through
`geocoding-api.open-meteo.com/v1/search?name=` (same connector). Cache what
you fetch in `AcuvoData` when the same answer serves every visitor, so a
popular page does not spend the free tier on one number.

## What to tell the person

When a call needs a key the owner has not stored, the proxy answers
`unknown_secret`. Show "Add your <Service> key in the workspace to turn this
on", name the connector, and keep the rest of the app working.

## Take payments (Stripe Checkout)

The secret key never touches the page. A server function creates the Checkout
session through the `stripe` connector (the owner stores the key once, in API
keys → Stripe), the page sends the visitor to it, and Stripe's webhook marks the
order paid:

```js
// functions/checkout.js — called from the page: const { url } = await AcuvoFunctions.call('checkout', { orderId })
module.exports = async function (args, ctx) {
  const order = await ctx.data.get('orders', String(args.orderId));
  if (!order || order.paid) throw new Error('no such open order');
  const form = new URLSearchParams({
    mode: 'payment', 'line_items[0][price_data][currency]': 'aud',
    'line_items[0][price_data][product_data][name]': order.title, 'line_items[0][price_data][unit_amount]': String(order.cents),
    'line_items[0][quantity]': '1', client_reference_id: String(args.orderId),
    success_url: args.returnTo + '?paid=1', cancel_url: args.returnTo + '?cancelled=1',
  });
  const r = await ctx.proxy.fetch('stripe', 'https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  return { url: r.body.url };                  // a refused call throws (proxy refused: HTTP 4xx), so there is nothing to check here
};
```

Then `functions/stripe-events.js` (see the app-functions skill) receives
`checkout.session.completed`, reads `client_reference_id`, and sets `paid: true`
on the order — only when `args.hook.signed` is true. Never mark an order paid
from the page's `?paid=1` return; the webhook is the receipt. Amounts are
integer cents; keep the price on the server record, never in the page's request.
PayPal and Square work the same way through their connectors.

## Your own Supabase project (or any host the catalogue does not list)

The owner stores a key in API keys with the host pattern and the header it wants, and the
app calls it by name — the key never reaches the page:
`name: supabase · hosts: *.supabase.co · header: apikey`. Then
`AcuvoProxy.fetch('supabase', 'https://<ref>.supabase.co/rest/v1/todos?select=*')` or, from a
function, `ctx.proxy.fetch('supabase', url, { headers: { Prefer: 'return=representation' } })`.
The same shape covers a private API of the owner's own.
