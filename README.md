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

// Track an event (non-blocking, batched automatically)
wl.track({ event_type: "signup", user_id: "u_123", event_properties: { plan: "free" } });

// Identify a user (bind device → user, set profile)
wl.identify({ user_id: "alice@acme.org", user_properties: { plan: "pro" } });

// All subsequent track() calls include user_id automatically
wl.track({ event_type: "checkout", event_properties: { amount: 42 } });

// Flush remaining events on shutdown (Node.js)
await wl.close();
```

## Design Principles

This client is designed to **never break your application**:

- **Non-blocking**: `track()` buffers events and returns immediately — no HTTP calls on the hot path
- **Automatic batching**: Events are sent in batches (10 per batch or every 2 seconds) in both Node.js and browsers
- **Bounded memory**: Queue capped at 500 events — oldest events are dropped when full
- **Retry with backoff**: Transient failures (429, 5xx, network) are retried up to 3 times
- **Graceful shutdown**: `close()` flushes remaining events (Node.js); page lifecycle hooks handle browsers

## Node.js Buffering

`track()` buffers events in both Node.js and browsers:
- Flushes on every 10 queued events or every 2 seconds
- Retries transient failures (429, 5xx, network) with exponential backoff (up to 3 retries)
- Queue is capped at 500 events (oldest events are dropped first)
- Call `close()` before process exit to flush remaining events

`trackBatch()` always sends immediately as one request (up to 2000 events).

## Browser Delivery

In browsers, the same buffering applies with additional lifecycle hooks:
- Flushes on `visibilitychange` (hidden) and `pagehide` using `fetch(..., { keepalive: true })`
- Auto-manages `device_id`, `session_id`, and `user_id` via localStorage/sessionStorage
- Shares identity with the `wirelog.js` script tag (`wl_did`, `wl_uid` keys)
- Auto-injects `url`, `language`, `timezone` into `event_properties`
- Auto-captures UTM attribution (`utm_*`, `gclid`, `fbclid`)

## Configuration

```typescript
import { WireLog } from "wirelog";

const client = new WireLog({
  apiKey: "sk_...",         // Falls back to WIRELOG_API_KEY env var (Node.js)
  host: "https://...",      // Falls back to WIRELOG_HOST env var (Node.js)
  onError: (err) => {       // Background error callback (Node.js)
    console.error(err);
  },
  disabled: false,          // true = track() is a no-op
});

// Use the client
await client.track({ event_type: "test" });
await client.close();
```

## API

### `wl.init(config)`

Initialize the singleton with your API key. Call once at app startup.

### `wl.track(event)`

Track a single event. Buffered in both Node.js and browsers — returns `{ accepted: 1, buffered: true }` immediately.

### `wl.trackBatch(events)`

Track multiple events in one request (up to 2000). Sends immediately.

### `wl.flush()`

Flush buffered events immediately. Blocks until the current queue is drained.

### `wl.close()`

Flush remaining events and stop the client. After `close()`, `track()` calls are silently dropped. Idempotent.

### `wl.query(q, opts?)`

Run a pipe DSL query. Options: `format` (`"llm"`, `"json"`, `"csv"`), `limit`, `offset`.

### `wl.identify(params)`

Bind a device to a user and/or set profile properties. Supports `user_property_ops` (`$set`, `$set_once`, `$add`, `$unset`).

### `wl.reset()`

Clear identity state (browser only). Generates a new device ID and clears the stored user.

### `wl.deviceId` / `wl.userId`

Read-only accessors for the current browser identity. Returns `null` in Node.

## Zero Runtime Dependencies

This library uses only the native `fetch` and Web Crypto APIs. No `axios`, no `node-fetch`, no `got`. Works in Node 18+ and all modern browsers.

## Learn More

- [WireLog](https://wirelog.ai) — headless analytics for agents and LLMs
- [Query language docs](https://docs.wirelog.ai/query-language/overview/)
- [API reference](https://docs.wirelog.ai/reference/api/)
