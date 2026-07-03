// Custom `toMatchSchema` matcher (PRD §B.3): validates a payload against a
// hand-written zod schema and pretty-prints every issue (path + message) on
// failure. Specs import `expect` from HERE (and `test` from the fixtures).

import type { z } from 'zod';
import { expect as baseExpect, type ApiResult } from '../../fixtures/index.js';
import { ProblemSchema } from '../schemas/common.js';

export const expect = baseExpect.extend({
  toMatchSchema(received: unknown, schema: z.ZodType) {
    const parsed = schema.safeParse(received);
    if (parsed.success) {
      return {
        pass: true,
        name: 'toMatchSchema',
        message: () => 'expected payload NOT to match the contract schema, but it did',
      };
    }
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
        return `  - at ${path}: ${issue.message}`;
      })
      .join('\n');
    const rendered = JSON.stringify(received, null, 2) ?? String(received);
    const truncated = rendered.length > 4000 ? `${rendered.slice(0, 4000)}\n  ... (truncated)` : rendered;
    return {
      pass: false,
      name: 'toMatchSchema',
      message: () =>
        [
          `Payload does not match the contract schema (${parsed.error.issues.length} issue(s)):`,
          issues,
          '',
          'Received:',
          truncated,
        ].join('\n'),
    };
  },
});

/**
 * Assert an ApiResult is an RFC 9457 problem: exact status code, the
 * `application/problem+json` media type, the Problem schema, and a body
 * `status` member that echoes the HTTP status.
 */
export function expectProblem(res: ApiResult<unknown>, status: number, what?: string): void {
  const label = what ? ` [${what}]` : '';
  expect(res.status, `HTTP status${label}`).toBe(status);
  expect(res.headers['content-type'] ?? '', `content-type${label}`).toContain('application/problem+json');
  expect(res.json).toMatchSchema(ProblemSchema);
  expect((res.json as { status?: number }).status, `problem.status member${label}`).toBe(status);
}
