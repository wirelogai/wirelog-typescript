# wirelog

[WireLog](https://wirelog.ai) analytics client for Node.js and browsers. **Zero runtime dependencies** — uses native `fetch` and Web Crypto.

## Install

```bash
npm install wirelog
```

## Quick Start

```typescript
import { WireLog } from "wirelog";

const wl = new WireLog({ apiKey: "sk_your_secret_key" });

// Track an event
await wl.track({ event_type: "signup", user_id: "u_123", event_properties: { plan: "free" } });

// Query analytics (returns Markdown by default)
const result = await wl.query("signup | last 7d | count by day");
console.log(result);

// Identify a user (bind device → user, set profile)
await wl.identify({ user_id: "alice@acme.org", device_id: "dev_abc", user_properties: { plan: "pro" } });
```

## Browser Usage

In browsers, the client automatically manages `device_id`, `session_id`, and `user_id` — matching the same localStorage keys as the `wirelog.js` script tag (`wl_did`, `wl_uid`). This means you can use both SDKs on the same page and identity is shared:

```typescript
// React app — identity auto-injected into every track() call
import { WireLog } from "wirelog";

const wl = new WireLog({ apiKey: "pk_your_public_key", host: "https://your-wirelog.example.com" });

// No need to pass device_id/session_id — auto-populated from browser state
await wl.track({ event_type: "checkout", event_properties: { amount: 42 } });

// Identify once — persists to localStorage, shared with wirelog.js script tag
await wl.identify({ user_id: "alice@acme.org", user_properties: { plan: "pro" } });

// All subsequent track() calls include user_id automatically
await wl.track({ event_type: "upgrade", event_properties: { to: "enterprise" } });
```

If the `wirelog.js` script tag is also on the page, both SDKs read/write the same `wl_did` and `wl_uid` localStorage keys. Calling `identify()` from either SDK makes the user visible to both.

## Configuration

```typescript
const wl = new WireLog({
  apiKey: "sk_...",                     // required
  host: "https://api.wirelog.ai",       // optional, defaults to api.wirelog.ai
});
```

## API

### `wl.track(event)`

Track a single event. Auto-generates `insert_id` and `time` if not provided. In browsers, auto-injects `device_id`, `session_id`, and `user_id`.

### `wl.trackBatch(events)`

Track multiple events in one request (up to 2000). In browsers, auto-injects identity per event.

### `wl.query(q, opts?)`

Run a pipe DSL query. Options: `format` (`"llm"`, `"json"`, `"csv"`), `limit`, `offset`.

### `wl.identify(params)`

Bind a device to a user and/or set profile properties. Supports `user_property_ops` (`$set`, `$set_once`, `$add`, `$unset`). In browsers, persists `user_id` to localStorage.

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
