// RFC 9457 application/problem+json errors (PRD §A.4).

const PROBLEM_BASE = 'https://vaultchain.example/problems';

export class ApiProblem extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;

  constructor(status: number, slug: string, title: string, detail?: string) {
    super(detail ?? title);
    this.status = status;
    this.type = `${PROBLEM_BASE}/${slug}`;
    this.title = title;
    this.detail = detail;
  }

  toBody(): Record<string, unknown> {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

export const notFound = (what: string) => new ApiProblem(404, 'not-found', 'Not found', `${what} not found`);
export const forbidden = (detail: string) => new ApiProblem(403, 'forbidden', 'Forbidden', detail);
export const unauthorized = () => new ApiProblem(401, 'unauthorized', 'Unauthorized', 'Missing or invalid X-Api-Key');
export const conflict = (slug: string, detail: string) => new ApiProblem(409, slug, 'Conflict', detail);
export const unprocessable = (slug: string, detail: string) => new ApiProblem(422, slug, 'Unprocessable', detail);
