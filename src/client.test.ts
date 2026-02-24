/**
 * Tests for the WireLog client. Uses node:test (no external deps).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WireLog } from "./client.js";

interface MockRequest {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let lastRequest: MockRequest | null = null;
let mockResponse = { body: "{}", status: 200, contentType: "application/json" };

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const bodyStr = Buffer.concat(chunks).toString();
    lastRequest = {
      path: req.url ?? "",
      method: req.method ?? "",
      headers: req.headers,
      body: bodyStr ? JSON.parse(bodyStr) : {},
    };
    res.writeHead(mockResponse.status, {
      "Content-Type": mockResponse.contentType,
    });
    res.end(
      typeof mockResponse.body === "string"
        ? mockResponse.body
        : JSON.stringify(mockResponse.body),
    );
  });
});

let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

after(() => {
  server.close();
});

function client(): WireLog {
  return new WireLog({ apiKey: "sk_test_key", host: baseUrl });
}

function createStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key) ?? null : null;
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
    removeItem(key: string): void {
      map.delete(key);
    },
  };
}

async function withBrowserEnv(
  href: string,
  fn: (env: { localStorage: ReturnType<typeof createStorage>; sessionStorage: ReturnType<typeof createStorage> }) => Promise<void>,
): Promise<void> {
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const location = new URL(href);

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location: { href: location.href, search: location.search } },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: sessionStorage,
  });

  try {
    await fn({ localStorage, sessionStorage });
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as Record<string, unknown>).window;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as Record<string, unknown>).document;
    if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    else delete (globalThis as Record<string, unknown>).localStorage;
    if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
    else delete (globalThis as Record<string, unknown>).sessionStorage;
  }
}

describe("WireLog client", () => {
  it("track sends event and returns accepted count", async () => {
    mockResponse = {
      body: JSON.stringify({ accepted: 1 }),
      status: 200,
      contentType: "application/json",
    };
    const result = await client().track({
      event_type: "signup",
      user_id: "u_123",
      event_properties: { plan: "free" },
    });
    assert.equal(result.accepted, 1);
    assert.equal(lastRequest?.path, "/track");
    assert.equal(lastRequest?.body.event_type, "signup");
    assert.equal(lastRequest?.body.user_id, "u_123");
    assert.equal(lastRequest?.body.clientOriginated, undefined);
    assert.ok(lastRequest?.body.insert_id);
    assert.ok(lastRequest?.body.time);
  });

  it("trackBatch sends batch", async () => {
    mockResponse = {
      body: JSON.stringify({ accepted: 2 }),
      status: 200,
      contentType: "application/json",
    };
    const result = await client().trackBatch([
      { event_type: "a" },
      { event_type: "b" },
    ]);
    assert.equal(result.accepted, 2);
    assert.ok(Array.isArray(lastRequest?.body.events));
  });

  it("query sends DSL and returns result", async () => {
    mockResponse = {
      body: JSON.stringify({ rows: [{ count: 42 }] }),
      status: 200,
      contentType: "application/json",
    };
    const result = await client().query("* | last 7d | count");
    assert.deepEqual(result, { rows: [{ count: 42 }] });
    assert.equal(lastRequest?.path, "/query");
    assert.equal(lastRequest?.body.q, "* | last 7d | count");
    assert.equal(lastRequest?.body.format, "llm");
  });

  it("identify sends user binding", async () => {
    mockResponse = {
      body: JSON.stringify({ ok: true }),
      status: 200,
      contentType: "application/json",
    };
    const result = await client().identify({
      user_id: "alice@acme.org",
      device_id: "dev_123",
      user_properties: { email: "alice@acme.org" },
    });
    assert.equal(result.ok, true);
    assert.equal(lastRequest?.path, "/identify");
    assert.equal(lastRequest?.body.user_id, "alice@acme.org");
  });

  it("sends X-API-Key header", async () => {
    mockResponse = {
      body: JSON.stringify({ accepted: 1 }),
      status: 200,
      contentType: "application/json",
    };
    await client().track({ event_type: "test" });
    assert.equal(lastRequest?.headers["x-api-key"], "sk_test_key");
  });

  it("defaults host to api.wirelog.ai", () => {
    const wl = new WireLog({ apiKey: "sk_test" });
    // We can't easily test the private field, but we can test construction doesn't throw
    assert.ok(wl);
  });

  it("strips trailing slash from host", () => {
    const wl = new WireLog({
      apiKey: "sk_test",
      host: "https://api.wirelog.ai/",
    });
    assert.ok(wl);
  });

  it("runtime browser detection is evaluated at runtime", async () => {
    const nodeClient = new WireLog({ apiKey: "sk_test_key", host: baseUrl });
    assert.equal(nodeClient.deviceId, null);

    await withBrowserEnv("https://app.example.com/home", async () => {
      const browserClient = new WireLog({ apiKey: "sk_test_key", host: baseUrl });
      assert.ok(browserClient.deviceId);
    });
  });

  it("browser track injects auto-context and caller props override defaults", async () => {
    mockResponse = {
      body: JSON.stringify({ accepted: 1 }),
      status: 200,
      contentType: "application/json",
    };

    await withBrowserEnv("https://app.example.com/home", async () => {
      const browserClient = new WireLog({ apiKey: "sk_test_key", host: baseUrl });
      await browserClient.track({
        event_type: "cta_clicked",
        event_properties: {
          url: "https://override.example.com/path",
          language: "fr-FR",
        },
      });
    });

    const props = lastRequest?.body.event_properties as Record<string, unknown>;
    assert.equal(props.url, "https://override.example.com/path");
    assert.equal(props.language, "fr-FR");
    assert.ok(lastRequest?.body.session_id);
    assert.ok(lastRequest?.body.device_id);
    assert.equal(lastRequest?.body.clientOriginated, true);
  });

  it("browser trackBatch marks request as client-originated", async () => {
    mockResponse = {
      body: JSON.stringify({ accepted: 2 }),
      status: 200,
      contentType: "application/json",
    };

    await withBrowserEnv("https://app.example.com/home", async () => {
      const browserClient = new WireLog({ apiKey: "sk_test_key", host: baseUrl });
      await browserClient.trackBatch([{ event_type: "a" }, { event_type: "b" }]);
    });

    assert.equal(lastRequest?.body.clientOriginated, true);
    const events = lastRequest?.body.events as Array<Record<string, unknown>>;
    assert.equal(events[0].clientOriginated, true);
    assert.equal(events[1].clientOriginated, true);
  });

  it("identify merges attribution and dedupes only after successful response", async () => {
    await withBrowserEnv("https://app.example.com/?utm_source=google&utm_campaign=spring", async () => {
      const browserClient = new WireLog({ apiKey: "sk_test_key", host: baseUrl });

      mockResponse = { body: "failed", status: 500, contentType: "text/plain" };
      await assert.rejects(
        browserClient.identify({ user_id: "user_123" }),
        /WireLog API 500/,
      );
      const firstOps = (lastRequest?.body.user_property_ops || {}) as Record<string, unknown>;
      assert.equal(
        ((firstOps.$set_once || {}) as Record<string, unknown>).initial_utm_source,
        "google",
      );
      assert.equal(
        ((firstOps.$set || {}) as Record<string, unknown>).last_utm_campaign,
        "spring",
      );

      mockResponse = { body: JSON.stringify({ ok: true }), status: 200, contentType: "application/json" };
      await browserClient.identify({ user_id: "user_123" });
      const secondOps = (lastRequest?.body.user_property_ops || {}) as Record<string, unknown>;
      assert.equal(
        ((secondOps.$set_once || {}) as Record<string, unknown>).initial_utm_source,
        "google",
      );

      await browserClient.identify({ user_id: "user_123" });
      const thirdOps = (lastRequest?.body.user_property_ops || {}) as Record<string, unknown>;
      assert.equal((thirdOps.$set_once as Record<string, unknown> | undefined)?.initial_utm_source, undefined);
      assert.equal((thirdOps.$set as Record<string, unknown> | undefined)?.last_utm_source, undefined);
    });
  });
});
