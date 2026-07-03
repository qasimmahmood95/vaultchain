// Thin typed wrapper over Playwright's APIRequestContext (PRD §B.2).
// Suites import this instead of hand-rolling fetch: one place for the
// base URL, JSON envelopes, and problem+json-aware failures.

import type { APIRequestContext, APIResponse } from '@playwright/test';

/** Single source of the platform base URL for fixtures and config alike. */
export const API_BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  json: T;
  headers: Record<string, string>;
}

async function toResult<T>(res: APIResponse): Promise<ApiResult<T>> {
  const text = await res.text();
  return {
    status: res.status(),
    json: (text ? JSON.parse(text) : {}) as T,
    headers: res.headers(),
  };
}

/**
 * Thin client: no retries, no clever error mapping — tests assert on status
 * and body themselves. `expectOk` is the only convenience: it throws with the
 * problem+json detail when a setup call (builder plumbing) unexpectedly fails.
 */
export class ApiClient {
  constructor(private readonly ctx: APIRequestContext) {}

  async get<T = Record<string, unknown>>(path: string): Promise<ApiResult<T>> {
    return toResult<T>(await this.ctx.get(path));
  }

  async post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<ApiResult<T>> {
    return toResult<T>(await this.ctx.post(path, body === undefined ? {} : { data: body }));
  }

  async delete<T = Record<string, unknown>>(path: string): Promise<ApiResult<T>> {
    return toResult<T>(await this.ctx.delete(path));
  }

  /** For builder plumbing only: throw loudly (with problem detail) on non-2xx. */
  async expectOk<T = Record<string, unknown>>(result: Promise<ApiResult<T>>, what: string): Promise<T> {
    const r = await result;
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    }
    return r.json;
  }
}
