/**
 * WireLog analytics client for Node.js and browsers.
 * Zero runtime dependencies — uses native fetch and Web Crypto.
 *
 * In browsers, automatically piggybacks on the wirelog.js script tag's
 * localStorage identity (device_id, user_id) and manages session_id,
 * so events from both SDKs share the same user identity.
 */

// ---------------------------------------------------------------------------
// Environment detection helpers
// ---------------------------------------------------------------------------

const isBrowser =
  typeof window !== "undefined" && typeof document !== "undefined";

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min, matches wirelog.js

function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Fallback: v4 UUID via getRandomValues (Node 18, older Safari).
  const buf = new Uint8Array(16);
  c.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
  buf[8] = (buf[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Generate a 24-char hex ID, matching wirelog.js format. */
function hexId(): string {
  const arr = new Uint8Array(12);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Safe localStorage wrappers — never throw.
// Keys match wirelog.js script tag: "wl_did" (device), "wl_uid" (user).
function lsGet(key: "wl_did" | "wl_uid"): string | null {
  if (!isBrowser) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: "wl_did" | "wl_uid", value: string): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked — best-effort */
  }
}

export interface WireLogConfig {
  /** API key (pk_, sk_, or aat_). */
  apiKey?: string;
  /** API base URL. Defaults to https://api.wirelog.ai. */
  host?: string;
}

export interface TrackEvent {
  event_type: string;
  user_id?: string;
  device_id?: string;
  session_id?: string;
  time?: string;
  event_properties?: Record<string, unknown>;
  user_properties?: Record<string, unknown>;
  insert_id?: string;
}

export interface TrackResult {
  accepted: number;
}

export interface IdentifyParams {
  user_id: string;
  device_id?: string;
  user_properties?: Record<string, unknown>;
  user_property_ops?: {
    $set?: Record<string, unknown>;
    $set_once?: Record<string, unknown>;
    $add?: Record<string, number>;
    $unset?: string[];
  };
}

export interface IdentifyResult {
  ok: boolean;
}

export interface QueryOptions {
  format?: "llm" | "json" | "csv";
  limit?: number;
  offset?: number;
}

/** Error thrown when the WireLog API returns a non-2xx response. */
export class WireLogError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(`WireLog API ${status}: ${message}`);
    this.name = "WireLogError";
    this.status = status;
  }
}

export class WireLog {
  private apiKey: string;
  private host: string;
  private _initialized = false;

  // Browser identity state — populated only when running in a browser.
  private _deviceId: string | null = null;
  private _sessionId: string | null = null;
  private _lastActivity = 0;
  private _userId: string | null = null;

  constructor(config: WireLogConfig = {}) {
    this.apiKey = config.apiKey ?? "";
    this.host = (config.host ?? "https://api.wirelog.ai").replace(/\/$/, "");
    if (this.apiKey) this._initialized = true;

    if (isBrowser) {
      // Piggyback on wirelog.js localStorage keys if present.
      this._deviceId = lsGet("wl_did");
      if (!this._deviceId) {
        this._deviceId = hexId();
        lsSet("wl_did", this._deviceId);
      }
      this._userId = lsGet("wl_uid") || null;
      this._sessionId = hexId();
      this._lastActivity = Date.now();
    }
  }

  /** Current device ID (browser-only, null in Node). */
  get deviceId(): string | null {
    return this._deviceId;
  }

  /** Current user ID (browser-only, null in Node until identify). */
  get userId(): string | null {
    return this._userId;
  }

  /** Initialize the client with config. Use with the singleton: `wl.init({ apiKey: "pk_..." })`. */
  init(config: WireLogConfig): void {
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.host) this.host = config.host.replace(/\/$/, "");
    this._initialized = true;
  }

  /** Track a single event. In browsers, auto-injects device/session/user IDs. */
  async track(event: TrackEvent): Promise<TrackResult> {
    const body: TrackEvent = {
      ...this.browserIdentity(),
      ...event,
      insert_id: event.insert_id ?? uuid(),
      time: event.time ?? new Date().toISOString(),
    };
    return this.post("/track", body) as Promise<TrackResult>;
  }

  /** Track multiple events in one request (up to 2000). In browsers, auto-injects identity per event. */
  async trackBatch(events: TrackEvent[]): Promise<TrackResult> {
    const identity = this.browserIdentity();
    const enriched = events.map((e) => ({
      ...identity,
      ...e,
      insert_id: e.insert_id ?? uuid(),
      time: e.time ?? new Date().toISOString(),
    }));
    return this.post("/track", { events: enriched }) as Promise<TrackResult>;
  }

  /** Run a pipe DSL query. Returns Markdown (default), JSON, or CSV. */
  async query(q: string, opts?: QueryOptions): Promise<unknown> {
    return this.post("/query", {
      q,
      format: opts?.format ?? "llm",
      limit: opts?.limit ?? 100,
      offset: opts?.offset ?? 0,
    });
  }

  /**
   * Bind a device to a user and/or set profile properties.
   * In browsers, also persists user_id to localStorage so it's shared
   * with the wirelog.js script tag and survives page reloads.
   */
  async identify(params: IdentifyParams): Promise<IdentifyResult> {
    if (isBrowser) {
      this._userId = params.user_id;
      lsSet("wl_uid", params.user_id);
    }
    const body: IdentifyParams = {
      ...params,
      device_id: params.device_id || this._deviceId || undefined,
    };
    return this.post("/identify", body) as Promise<IdentifyResult>;
  }

  /** Clear identity state. In browsers, generates a new device ID and clears user. */
  reset(): void {
    if (!isBrowser) return;
    this._userId = null;
    this._sessionId = null;
    this._lastActivity = 0;
    // Match wirelog.js reset behavior: new device, clear stored user.
    lsSet("wl_did", "");
    lsSet("wl_uid", "");
    this._deviceId = hexId();
    lsSet("wl_did", this._deviceId);
  }

  /**
   * Returns identity fields to merge into events when running in a browser.
   * In Node this returns an empty object so explicit caller values are used as-is.
   */
  private browserIdentity(): Partial<TrackEvent> {
    if (!isBrowser) return {};

    // Session rotation on inactivity, matching wirelog.js SESSION_TIMEOUT.
    const now = Date.now();
    if (!this._sessionId || now - this._lastActivity > SESSION_TIMEOUT) {
      this._sessionId = hexId();
    }
    this._lastActivity = now;

    // Re-read userId from localStorage in case wirelog.js updated it.
    const storedUid = lsGet("wl_uid");
    if (storedUid && storedUid !== this._userId) {
      this._userId = storedUid;
    }

    return {
      device_id: this._deviceId ?? undefined,
      session_id: this._sessionId,
      user_id: this._userId ?? undefined,
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    if (!this._initialized) {
      console.warn("wirelog: call wl.init({ apiKey }) before tracking events");
      return {};
    }
    const url = `${this.host}${path}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new WireLogError(resp.status, text);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return resp.json();
    }
    return resp.text();
  }
}

/** Module-level singleton. Call `wl.init({ apiKey })` once, then use everywhere. */
export const wl = new WireLog();
