---
name: api-design
description: REST shapes, status codes that mean something, idempotency and pagination that survives growth
when: When adding an endpoint, designing a route, or deciding what a handler returns
---

# API design

## Nouns in the path, verbs in the method

```
✗ POST /createInvoice        ✗ GET /getInvoiceById?id=7
✓ POST /invoices             ✓ GET  /invoices/7
✓ PATCH /invoices/7          ✓ DELETE /invoices/7
```

`GET` never changes anything — crawlers, prefetchers and browser history all
assume that, and one of them will eventually prove it.

## Status codes are the API's error handling

| code | meaning | the mistake it prevents |
|---|---|---|
| 200 | here it is | — |
| 201 | created, `Location:` points at it | 200 with a body you have to parse to learn the id |
| 400 | your request is malformed | using 500 for a typo |
| 401 | who are you? | conflated with 403 |
| 403 | I know who you are; no | conflated with 401 |
| 404 | no such thing | 200 with `{"error":"not found"}` |
| 409 | conflicts with current state | 400 for a duplicate |
| 422 | shape is fine, values are not | 400 for everything |
| 429 | slow down | silence |
| 500 | **we** broke | blaming the caller |

⚠️ `200 {"success": false}` forces every client to parse a body to discover
failure, and defeats every retry, cache and monitor in the path.

## ⚠️⚠️ Idempotency: the network will deliver twice

A client that times out will retry. Without an idempotency key, the customer is
charged twice and the receipt is genuine.

```
POST /payments
Idempotency-Key: 8f3a…            ← client-generated, stored with the result
```

Same key → return the FIRST result, do not perform the work again. `PUT` and
`DELETE` are naturally idempotent; `POST` is the one that needs help.

## Pagination: never return everything

`GET /invoices` on a table that grows is a timeout waiting for a customer big
enough to trigger it.

- **Offset** (`?page=3&limit=50`) is simple and drifts: rows inserted while
  paging shift the window and items are seen twice or missed.
- **Cursor** (`?after=<opaque>&limit=50`) is stable and is what to use for
  anything ordered by time.

Always cap `limit` server-side. A client asking for 1,000,000 gets your maximum,
not an outage.

## Consistent shapes

Pick one envelope and use it everywhere:

```json
{ "data": [...], "next_cursor": "…" }
{ "error": { "code": "invoice_not_found", "message": "No invoice with id 7" } }
```

A machine-readable `code` plus a human-readable `message` — clients branch on
the code, humans read the message. Never make a client match on prose.

## Versioning, dates and money

- Version before you need it: `/v1/`. Removing a version is a conversation;
  breaking an unversioned API is an outage.
- Timestamps in **UTC ISO-8601** with an offset. Never a bare local time.
- Money in **integer minor units** with a currency (`{"amount": 1250,
  "currency": "AUD"}`). Floating point and money do not belong together.
