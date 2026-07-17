// Minimal timed HTTP client for the perf scenarios. Deliberately NOT the
// Playwright fixtures' ApiClient: perf runs outside the Playwright runner
// (D37) and needs per-request latency, nothing else.

export interface TimedResponse {
  status: number;
  json: unknown;
  ms: number;
}

export class PerfApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  withKey(apiKey: string): PerfApi {
    return new PerfApi(this.baseUrl, apiKey);
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<TimedResponse> {
    const started = performance.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, ms };
  }

  get(path: string): Promise<TimedResponse> {
    return this.request('GET', path);
  }

  post(path: string, body?: unknown): Promise<TimedResponse> {
    return this.request('POST', path, body);
  }

  /** POST that throws (with the response body) unless 2xx — for scenario SETUP steps. */
  async mustPost(path: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const res = await this.post(path, body);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${what}: ${res.status} ${JSON.stringify(res.json)}`);
    }
    return res.json as Record<string, unknown>;
  }
}
