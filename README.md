# wirelog

[WireLog](https://wirelog.ai) analytics client for Node.js and browsers. **Zero runtime dependencies** — uses native `fetch` and Web Crypto.

## Install

```bash
npm install wirelog
```

## Quick Start

```typescript
import { wl } from "wirelog";

wl.init({ apiKey: "pk_your_public_key" });

// Track an event
wl.track({ event_type: "signup", user_id: "u_123", event_properties: { plan: "free" } });

// Identify a user (bind device → user, set profile)
wl.identify({ user_id: "alice@acme.org", user_properties: { plan: "pro" } });

// All subsequent track() calls include user_id automatically
wl.track({ event_type: "checkout", event_properties: { amount: 42 } });
```

In browsers, the singleton automatically manages `device_id`, `session_id`, and `user_id` — matching the same localStorage keys as the `wirelog.js` script tag (`wl_did`, `wl_uid`). If both SDKs are on the page, calling `identify()` from either one makes the user visible to both.

Browser `track()` and `trackBatch()` auto-inject event context into `event_properties`:
- `url`
- `language`
- `timezone`

Browser events are also marked with `clientOriginated: true` automatically.

Caller-provided `event_properties` win on key conflicts.

## Browser Delivery (Breaking Change)

In browsers, `track()` now buffers events locally and flushes them asynchronously in small batches:
- Flushes on every 10 queued events or every 2 seconds
- Retries transient failures (`429`, `5xx`, network) with backoff (up to 3 retries)
- Flushes on `visibilitychange` (hidden) and `pagehide` using `fetch(..., { keepalive: true })`
- Queue is capped at 500 events (oldest events are dropped first)

`trackBatch()` is still explicit and sends immediately as one request (up to 2000 events).

## Explicit Instances

For server-side Node.js, multiple projects, or test isolation, create instances directly:

```typescript
import { WireLog } from "wirelog";

const client = new WireLog({ apiKey: "sk_your_secret_key" });

await client.track({ event_type: "invoice.paid", user_id: "u_123" });
const result = await client.query("invoice.paid | last 7d | count by day");
```

## API

### `wl.init(config)`

Initialize the singleton with your API key. Call once at app startup. If you skip this, `track()`/`identify()`/`query()` will `console.warn` and no-op.

### `wl.track(event)`

Track a single event. Auto-generates `insert_id` and `time` if not provided.

In browsers, `track()` is buffered by default: it enqueues the event and returns `{ accepted: 1, buffered: true }`.

In Node, `track()` sends immediately and returns the API response.

### `wl.trackBatch(events)`

Track multiple events in one request (up to 2000). In browsers, auto-injects identity and browser context per event, then sends immediately.

### `wl.flush()`

Flush buffered browser `track()` events immediately.

- Browser: sends queued events now and returns `{ accepted: N }`
- Node: no-op, returns `{ accepted: 0 }`

### `wl.query(q, opts?)`

Run a pipe DSL query. Options: `format` (`"llm"`, `"json"`, `"csv"`), `limit`, `offset`.

### `wl.identify(params)`

Bind a device to a user and/or set profile properties. Supports `user_property_ops` (`$set`, `$set_once`, `$add`, `$unset`). In browsers, persists `user_id` to localStorage.

`identify()` requires a non-empty `user_id`. In browser mode, pending URL attribution (`utm_*`, `gclid`, `fbclid`) is merged into one identify call:
- first touch -> `$set_once.initial_*`
- last touch -> `$set.last_*`

Attribution dedupe is marked only after a successful identify response.

### `wl.reset()`

Clear identity state. In browsers, generates a new device ID and clears the stored user. Matches the behavior of `window.wl.reset()`.

### `wl.deviceId` / `wl.userId`

Read-only accessors for the current browser identity. Returns `null` in Node.

## Zero Runtime Dependencies

This library uses only the native `fetch` and Web Crypto APIs. No `axios`, no `node-fetch`, no `got`. Works in Node 18+ and all modern browsers.

## Learn More

- [WireLog](https://wirelog.ai) — headless analytics for agents and LLMs
- [Query language docs](https://docs.wirelog.ai/query-language)
- [API reference](https://docs.wirelog.ai/reference/api)
