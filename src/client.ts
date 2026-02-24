/**
 * WireLog analytics client for Node.js and browsers.
 * Zero runtime dependencies — uses native fetch and Web Crypto.
 *
 * In browsers, automatically piggybacks on the wirelog.js script tag's
 * localStorage identity (device_id, user_id), manages session_id, and
 * buffers `track()` events with async batch flushes.
 */

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function isBrowserEnv(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min, matches wirelog.js
const BATCH_INTERVAL = 2000; // 2s, matches wirelog.js
const BATCH_MAX = 10;
const QUEUE_MAX = 500;
const RETRY_MAX = 3;
const RETRY_BASE_MS = 1000;

const ATTR_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
] as const;

const ATTR_FIRST_KEY = "wl_attr_first";
const ATTR_LAST_KEY = "wl_attr_last";
const ATTR_SYNC_USER_KEY = "wl_attr_sync_user";

const _crypto: Crypto | undefined = globalThis.crypto;

function uuid(): string {
  if (_crypto?.randomUUID) return _crypto.randomUUID();
  // Fallback for Node 18 where globalThis.crypto is undefined in ESM.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Generate a 24-char hex ID, matching wirelog.js format. */
function hexId(): string {
  if (_crypto?.getRandomValues) {
    const arr = new Uint8Array(12);
    _crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for Node 18.
  let hex = "";
  for (let i = 0; i < 24; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

// Safe storage wrappers — never throw.
function lsGet(key: "wl_did" | "wl_uid"): string | null {
  if (!isBrowserEnv()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: "wl_did" | "wl_uid", value: string): void {
  if (!isBrowserEnv()) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked — best-effort */
  }
}

function ssGet(key: string): string | null {
  if (!isBrowserEnv()) return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function ssSet(key: string, value: string): void {
  if (!isBrowserEnv()) return;
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* best effort */
  }
}

function ssRemove(key: string): void {
  if (!isBrowserEnv()) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* best effort */
  }
}

function readSessionJSON(key: string): Record<string, string> {
  const raw = ssGet(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v !== "") out[k] = v;
      }
      return out;
    }
  } catch {
    // ignore parse failure
  }
  return {};
}

function writeSessionJSON(key: string, value: Record<string, string>): void {
  ssSet(key, JSON.stringify(value));
}

function hasOwnKeys(obj: Record<string, unknown>): boolean {
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) return true;
  }
  return false;
}

function cloneMap<T>(obj?: Record<string, T>): Record<string, T> {
  if (!obj || typeof obj !== "object") return {};
  return { ...obj };
}

function extractAttributionFromLocation(): Record<string, string> {
  if (!isBrowserEnv()) return {};
  const out: Record<string, string> = {};
  try {
    const params = new URLSearchParams(window.location.search || "");
    for (const key of ATTR_PARAMS) {
      const value = params.get(key);
      if (value) out[key] = value;
    }
  } catch {
    // URLSearchParams unsupported or blocked
  }
  return out;
}

function applyAttributionProps(
  target: Record<string, unknown>,
  prefix: string,
  attrs: Record<string, string>,
): void {
  for (const key of ATTR_PARAMS) {
    const value = attrs[key];
    if (value) target[`${prefix}${key}`] = value;
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
  clientOriginated?: boolean;
  time?: string;
  event_properties?: Record<string, unknown>;
  user_properties?: Record<string, unknown>;
  insert_id?: string;
}

export interface TrackResult {
  accepted: number;
  /** True when events were queued locally in the browser (not yet acknowledged by the API). */
  buffered?: boolean;
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

type FlushReason = "manual" | "batch" | "interval" | "retry" | "hidden" | "pagehide";

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

  // Tracks the user_id for which attribution has already been merged.
  private _attrIdentified: string | null = null;
  private _queue: TrackEvent[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _retryCount = 0;
  private _flushPromise: Promise<TrackResult> | null = null;
  private _browserHooksInstalled = false;

  constructor(config: WireLogConfig = {}) {
    this.apiKey = config.apiKey ?? "";
    this.host = (config.host ?? "https://api.wirelog.ai").replace(/\/$/, "");
    if (this.apiKey) this._initialized = true;

    if (isBrowserEnv()) {
      // Piggyback on wirelog.js localStorage keys if present.
      this._deviceId = lsGet("wl_did");
      if (!this._deviceId) {
        this._deviceId = hexId();
        lsSet("wl_did", this._deviceId);
      }
      this._userId = lsGet("wl_uid") || null;
      this._sessionId = hexId();
      this._lastActivity = Date.now();
      this._attrIdentified = ssGet(ATTR_SYNC_USER_KEY) || null;

      // Keep attribution pending state up to date even before identify.
      this.captureAttribution();
      this.installBrowserFlushHooks();
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

  /** Track a single event. In browsers, this is buffered and flushed in async batches. */
  async track(event: TrackEvent): Promise<TrackResult> {
    const body = this.enrichEvent(event);
    if (!isBrowserEnv()) {
      return this.post("/track", body) as Promise<TrackResult>;
    }
    if (!this.ensureInitialized()) {
      return { accepted: 0, buffered: true };
    }

    this.enqueueBrowserEvents([body]);
    if (this._queue.length >= BATCH_MAX) {
      void this.flushQueuedEvents("batch");
    } else {
      this.scheduleFlush();
    }
    return { accepted: 1, buffered: true };
  }

  /**
   * Track multiple events in one request (up to 2000).
   * In browsers, this sends immediately (explicit batch) and auto-injects identity/context per event.
   */
  async trackBatch(events: TrackEvent[]): Promise<TrackResult> {
    const enriched = events.map((e) => this.enrichEvent(e));
    const body = isBrowserEnv() ? { events: enriched, clientOriginated: true } : { events: enriched };
    return this.post("/track", body) as Promise<TrackResult>;
  }

  /**
   * Flush buffered browser events immediately.
   * In Node this is a no-op and returns `{ accepted: 0 }`.
   */
  async flush(): Promise<TrackResult> {
    if (!isBrowserEnv()) return { accepted: 0 };
    if (!this.ensureInitialized()) return { accepted: 0, buffered: true };
    return this.flushQueuedEvents("manual");
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
    const userID = (params.user_id || "").trim();
    if (!userID) {
      throw new Error("wirelog: identify requires non-empty user_id");
    }

    let mergedOps = params.user_property_ops;
    let shouldMarkAttrSynced = false;

    if (isBrowserEnv()) {
      this._userId = userID;
      lsSet("wl_uid", userID);

      const attrs = this.captureAttribution();
      if (this._attrIdentified !== userID) {
        const setOnce = cloneMap(mergedOps?.$set_once);
        const set = cloneMap(mergedOps?.$set);

        applyAttributionProps(setOnce, "initial_", attrs.first);
        applyAttributionProps(set, "last_", attrs.last);

        mergedOps = {
          ...(mergedOps || {}),
          ...(hasOwnKeys(setOnce) ? { $set_once: setOnce } : {}),
          ...(hasOwnKeys(set) ? { $set: set } : {}),
        };

        shouldMarkAttrSynced = hasOwnKeys(attrs.first) || hasOwnKeys(attrs.last);
      }
    }

    const body: IdentifyParams = {
      ...params,
      user_id: userID,
      device_id: params.device_id || this._deviceId || undefined,
      user_property_ops: mergedOps,
    };

    const result = (await this.post("/identify", body)) as IdentifyResult;

    if (isBrowserEnv() && shouldMarkAttrSynced) {
      this._attrIdentified = userID;
      ssSet(ATTR_SYNC_USER_KEY, userID);
    }

    return result;
  }

  /** Clear identity state. In browsers, generates a new device ID and clears user. */
  reset(): void {
    if (!isBrowserEnv()) return;
    this._userId = null;
    this._sessionId = null;
    this._lastActivity = 0;
    this._attrIdentified = null;
    this._queue = [];
    this.clearFlushTimer();
    this.clearRetryTimer();
    this._retryCount = 0;

    // Match wirelog.js reset behavior: new device, clear stored user.
    lsSet("wl_did", "");
    lsSet("wl_uid", "");
    ssRemove(ATTR_SYNC_USER_KEY);
    ssRemove(ATTR_FIRST_KEY);
    ssRemove(ATTR_LAST_KEY);

    this._deviceId = hexId();
    lsSet("wl_did", this._deviceId);
  }

  private ensureInitialized(): boolean {
    if (this._initialized) return true;
    console.warn("wirelog: call wl.init({ apiKey }) before tracking events");
    return false;
  }

  private enqueueBrowserEvents(events: TrackEvent[]): void {
    for (const event of events) {
      if (this._queue.length >= QUEUE_MAX) {
        this._queue.shift();
      }
      this._queue.push(event);
    }
  }

  private scheduleFlush(): void {
    if (this._flushTimer || !this._queue.length) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flushQueuedEvents("interval");
    }, BATCH_INTERVAL);
  }

  private clearFlushTimer(): void {
    if (!this._flushTimer) return;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
  }

  private clearRetryTimer(): void {
    if (!this._retryTimer) return;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  private scheduleRetry(): void {
    if (this._retryTimer || !this._queue.length) return;
    const delay = Math.min(30000, RETRY_BASE_MS * Math.pow(2, this._retryCount));
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      void this.flushQueuedEvents("retry");
    }, delay + Math.floor(Math.random() * 250));
  }

  private installBrowserFlushHooks(): void {
    if (!isBrowserEnv() || this._browserHooksInstalled) return;
    this._browserHooksInstalled = true;

    if (typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", () => {
        void this.flushQueuedEvents("pagehide");
      });
    }

    if (typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          void this.flushQueuedEvents("hidden");
        }
      });
    }
  }

  private flushQueuedEvents(reason: FlushReason): Promise<TrackResult> {
    if (!isBrowserEnv() || !this._queue.length) return Promise.resolve({ accepted: 0 });
    if (!this.ensureInitialized()) return Promise.resolve({ accepted: 0, buffered: true });
    if (this._flushPromise) return this._flushPromise;

    this._flushPromise = this.drainQueuedEvents(reason).finally(() => {
      this._flushPromise = null;
      if (this._queue.length && !this._retryTimer) this.scheduleFlush();
    });
    return this._flushPromise;
  }

  private async drainQueuedEvents(reason: FlushReason): Promise<TrackResult> {
    if (!this._queue.length) return { accepted: 0 };

    this.clearFlushTimer();
    this.clearRetryTimer();

    let totalAccepted = 0;
    let sendReason = reason;
    while (this._queue.length) {
      const batch = this._queue.splice(0, Math.min(BATCH_MAX, this._queue.length));
      const outcome = await this.sendTrackBatch(batch, sendReason);

      if (outcome.ok) {
        totalAccepted += outcome.accepted;
        this._retryCount = 0;
        sendReason = "batch";
        continue;
      }

      if (!outcome.retryable) {
        this._retryCount = 0;
        continue;
      }

      // Put failed batch back at the front and retry with backoff.
      this._queue = batch.concat(this._queue);
      this._retryCount++;
      if (this._retryCount > RETRY_MAX) {
        this._queue.splice(0, batch.length);
        this._retryCount = 0;
        continue;
      }
      this.scheduleRetry();
      break;
    }

    return { accepted: totalAccepted };
  }

  private async sendTrackBatch(
    events: TrackEvent[],
    reason: FlushReason,
  ): Promise<{ ok: boolean; retryable: boolean; accepted: number }> {
    try {
      const result = await this.post(
        "/track",
        { events, clientOriginated: true },
        { keepalive: reason === "hidden" || reason === "pagehide" },
      );
      return {
        ok: true,
        retryable: false,
        accepted: this.acceptedFromTrackResponse(result, events.length),
      };
    } catch (err) {
      if (err instanceof WireLogError) {
        return {
          ok: false,
          retryable: this.isRetryableStatus(err.status),
          accepted: 0,
        };
      }
      return {
        ok: false,
        retryable: true,
        accepted: 0,
      };
    }
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600) || status === 0;
  }

  private acceptedFromTrackResponse(result: unknown, fallback: number): number {
    if (result && typeof result === "object" && "accepted" in result) {
      const accepted = (result as { accepted?: unknown }).accepted;
      if (typeof accepted === "number" && Number.isFinite(accepted)) return accepted;
    }
    return fallback;
  }

  private enrichEvent(event: TrackEvent): TrackEvent {
    const identity = this.browserIdentity();
    const props = this.mergeBrowserContext(event.event_properties);

    return {
      ...identity,
      ...event,
      event_properties: props,
      insert_id: event.insert_id ?? uuid(),
      time: event.time ?? new Date().toISOString(),
      clientOriginated: isBrowserEnv() ? true : event.clientOriginated,
    };
  }

  /**
   * Returns identity fields to merge into events when running in a browser.
   * In Node this returns an empty object so explicit caller values are used as-is.
   */
  private browserIdentity(): Partial<TrackEvent> {
    if (!isBrowserEnv()) return {};

    this.captureAttribution();

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

  private mergeBrowserContext(
    props?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!isBrowserEnv()) return props;

    const autoProps: Record<string, unknown> = {
      url: window.location.href,
    };
    if (navigator.language) autoProps.language = navigator.language;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) autoProps.timezone = tz;
    } catch {
      // Ignore Intl failures.
    }

    return {
      ...autoProps,
      ...(props || {}),
    };
  }

  private captureAttribution(): { first: Record<string, string>; last: Record<string, string> } {
    if (!isBrowserEnv()) return { first: {}, last: {} };

    const current = extractAttributionFromLocation();
    let first = readSessionJSON(ATTR_FIRST_KEY);
    let last = readSessionJSON(ATTR_LAST_KEY);

    if (hasOwnKeys(current)) {
      if (!hasOwnKeys(first)) {
        first = current;
        writeSessionJSON(ATTR_FIRST_KEY, first);
      }
      last = current;
      writeSessionJSON(ATTR_LAST_KEY, last);
    }

    return { first, last };
  }

  private async post(
    path: string,
    body: unknown,
    opts?: { keepalive?: boolean },
  ): Promise<unknown> {
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
      keepalive: opts?.keepalive ?? false,
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
