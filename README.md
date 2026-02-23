# wirelog

[WireLog](https://wirelog.ai) analytics client for Node.js and TypeScript. **Zero runtime dependencies** — uses native `fetch` (Node 18+).

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

## Configuration

```typescript
const wl = new WireLog({
  apiKey: "sk_...",         // or set WIRELOG_API_KEY env var
  host: "https://api.wirelog.ai", // or set WIRELOG_HOST env var
});
```

## API

### `wl.track(event)`

Track a single event. Auto-generates `insert_id` and `time` if not provided.

### `wl.trackBatch(events)`

Track multiple events in one request (up to 2000).

### `wl.query(q, opts?)`

Run a pipe DSL query. Options: `format` (`"llm"`, `"json"`, `"csv"`), `limit`, `offset`.

### `wl.identify(params)`

Bind a device to a user and/or set profile properties. Supports `user_property_ops` (`$set`, `$set_once`, `$add`, `$unset`).

## Zero Runtime Dependencies

This library uses only the native `fetch` API available in Node 18+. No `axios`, no `node-fetch`, no `got`. It works out of the box with any modern Node.js installation.

## Learn More

- [WireLog](https://wirelog.ai) — headless analytics for agents and LLMs
- [Query language docs](https://docs.wirelog.ai/query-language)
- [API reference](https://docs.wirelog.ai/reference/api)
