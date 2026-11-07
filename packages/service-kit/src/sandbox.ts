import {
  SbxJobRequest,
  SbxJobStatus,
  SbxSandboxList,
  type SbxJobRequest as JobRequest,
  type SbxJobStatus as JobStatus,
  type SbxSandboxList as SandboxList,
} from '@app/contracts';
import { ContractError } from './client.ts';

export class SandboxBusy extends Error {
  constructor(readonly retryAfterMs: number) {
    super('sandbox-manager is busy');
  }
}

/**
 * runner's client for sandbox-manager (Rust; its schema comes from `sandbox-manager --schema`). Requests and
 * responses are validated against that schema, like every other call.
 */
export function sandboxClient(opts: { baseUrl: string; token: string; fetch?: typeof fetch }) {
  const f = opts.fetch ?? fetch;
  async function req<T>(method: string, path: string, body: unknown, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }): Promise<T> {
    const res = await f(new URL(path, opts.baseUrl), {
      method,
      headers: { authorization: `Bearer ${opts.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 503) throw new SandboxBusy((json as { retry_after_ms?: number })?.retry_after_ms ?? 1000);
    if (res.status >= 300) throw new Error(`sandbox-manager ${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    const r = schema.safeParse(json);
    if (!r.success) throw new ContractError(`sandbox-manager ${method} ${path} response: ${r.error?.message}`);
    return r.data as T;
  }
  return {
    createJob: (job: JobRequest) => {
      const r = SbxJobRequest.safeParse(job);
      if (!r.success) throw new ContractError(`sandbox-manager job request: ${r.error.message}`);
      return req<JobStatus>('POST', '/jobs', job, SbxJobStatus);
    },
    getJob: (id: string) => req<JobStatus>('GET', `/jobs/${encodeURIComponent(id)}`, undefined, SbxJobStatus),
    release: (id: string) => req<JobStatus>('POST', `/jobs/${encodeURIComponent(id)}/release`, undefined, SbxJobStatus),
    kill: (id: string, reason: string, audit_row_id: string | null = null) =>
      req<JobStatus>('POST', `/jobs/${encodeURIComponent(id)}/kill`, { reason, audit_row_id }, SbxJobStatus),
    sandboxes: () => req<SandboxList>('GET', '/sandboxes', undefined, SbxSandboxList),
  };
}
export type SandboxClient = ReturnType<typeof sandboxClient>;
