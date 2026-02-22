/**
 * WireLog analytics client for Node.js.
 * Zero runtime dependencies — uses native fetch (Node 18+).
 */

export interface WireLogConfig {
  /** API key (pk_, sk_, or aat_). Falls back to WIRELOG_API_KEY env var. */
  apiKey?: string;
  /** API base URL. Falls back to WIRELOG_HOST env var or https://wirelog.ai. */
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

  constructor(config: WireLogConfig = {}) {
    this.apiKey =
      config.apiKey ?? process.env.WIRELOG_API_KEY ?? "";
    this.host = (
      config.host ??
      process.env.WIRELOG_HOST ??
      "https://wirelog.ai"
    ).replace(/\/$/, "");
  }

  /** Track a single event. */
  async track(event: TrackEvent): Promise<TrackResult> {
    const body: TrackEvent = {
      ...event,
      insert_id: event.insert_id ?? crypto.randomUUID(),
      time: event.time ?? new Date().toISOString(),
    };
    return this.post("/track", body) as Promise<TrackResult>;
  }

  /** Track multiple events in one request (up to 2000). */
  async trackBatch(
    events: TrackEvent[],
  ): Promise<TrackResult> {
    return this.post("/track", { events }) as Promise<TrackResult>;
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

  /** Bind a device to a user and/or set profile properties. */
  async identify(params: IdentifyParams): Promise<IdentifyResult> {
    return this.post("/identify", params) as Promise<IdentifyResult>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
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
