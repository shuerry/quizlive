/**
 * Store backed by the record DO's own tools endpoint (the same public
 * `/api/tools/execute` contract the scaffold's server actions use), called
 * in-process from inside the DO. X-App-Action skips per-user RBAC, the engine
 * is the authority; X-User-Id is the user stamped into userBound columns.
 */

import type { Rec, Store, WriteResult } from './engine'

type Fetch = (req: Request) => Promise<Response>

interface ToolReply {
  success: boolean
  error?: string
  data?: {
    recordId?: string
    record?: { recordId: string; data: unknown; createdBy?: string }
    records?: Array<{ recordId: string; data: unknown; createdBy?: string }>
  }
}

const NOT_FOUND = /not found/i

export function toolsStore(doFetch: Fetch, systemUserId: string): Store {
  async function exec(tool: string, params: Record<string, unknown>, userId: string): Promise<ToolReply> {
    const res = await doFetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId, 'X-App-Action': 'true' },
        body: JSON.stringify({ tool, params }),
      }),
    )
    return (await res.json()) as ToolReply
  }

  const write = (r: ToolReply): WriteResult =>
    r.success
      ? { ok: true, recordId: r.data?.recordId ?? r.data?.record?.recordId ?? '' }
      : { ok: false, error: r.error ?? 'write failed' }

  return {
    async get<T>(collection: string, recordId: string) {
      const r = await exec('records.get', { collection, recordId }, systemUserId)
      if (!r.success) {
        if (NOT_FOUND.test(r.error ?? '')) return null
        throw new Error(`records.get ${collection}: ${r.error}`)
      }
      return (r.data?.record ?? null) as Rec<T> | null
    },
    async query<T>(collection: string, where: Record<string, string | number>) {
      const r = await exec('records.query', { collection, where }, systemUserId)
      if (!r.success) throw new Error(`records.query ${collection}: ${r.error}`)
      return (r.data?.records ?? []) as Rec<T>[]
    },
    async create(collection, data, actingUserId, recordId) {
      return write(await exec('records.create', { collection, data, recordId }, actingUserId))
    },
    async update(collection, recordId, patch, actingUserId) {
      return write(await exec('records.update', { collection, recordId, data: patch }, actingUserId))
    },
    async remove(collection, recordId, actingUserId) {
      return write(await exec('records.delete', { collection, recordId }, actingUserId))
    },
  }
}
