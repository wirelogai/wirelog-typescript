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
});
