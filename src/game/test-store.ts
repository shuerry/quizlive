/**
 * Test-only in-memory Store that applies the same write rules the record DO
 * applies, read from the real schemas: userBound columns are stamped with the
 * acting user on create and kept on update, immutable columns refuse changes,
 * and uniqueOn refuses duplicates. Every call yields to the event loop first,
 * so un-serialized concurrent ops really do interleave.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { quizSchemas } from '../schemas/quiz-schemas'
import type { Rec, Store, WriteResult } from './engine'

export interface StoredRec extends Rec<Record<string, unknown>> {
  createdBy: string
  createdAt: string
  updatedAt: string
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export class MemoryStore implements Store {
  readonly tables = new Map<string, Map<string, StoredRec>>()
  private seq = 0
  constructor(readonly schemas: CollectionSchema[] = quizSchemas) {
    for (const s of schemas) this.tables.set(s.name, new Map())
  }

  private table(name: string) {
    const t = this.tables.get(name)
    if (!t) throw new Error(`unknown collection ${name}`)
    return t
  }
  private schema(name: string) {
    return this.schemas.find((s) => s.name === name)!
  }

  all(collection: string): StoredRec[] {
    return [...this.table(collection).values()]
  }

  async get<T>(collection: string, recordId: string) {
    await tick()
    const r = this.table(collection).get(recordId)
    return r ? (structuredClone(r) as unknown as Rec<T>) : null
  }

  async query<T>(collection: string, where: Record<string, string | number>) {
    await tick()
    return this.all(collection)
      .filter((r) => Object.entries(where).every(([k, v]) => r.data[k] === v))
      .map((r) => structuredClone(r) as unknown as Rec<T>)
  }

  async create(collection: string, data: Record<string, unknown>, actingUserId: string, recordId?: string) {
    await tick()
    const schema = this.schema(collection)
    const row: Record<string, unknown> = {}
    for (const col of schema.columns) {
      if (data[col.name] !== undefined) row[col.name] = structuredClone(data[col.name])
      else if (col.default !== undefined) row[col.name] = col.default
      if (col.userBound) row[col.name] = actingUserId
      if (col.required && (row[col.name] === undefined || row[col.name] === null || row[col.name] === '')) {
        return { ok: false, error: `Required field '${col.name}' is missing` } satisfies WriteResult
      }
    }
    const dup = this.uniqueClash(collection, row, undefined)
    if (dup) return { ok: false, error: dup } satisfies WriteResult
    const id = recordId ?? `${collection}-${++this.seq}`
    const now = new Date().toISOString()
    this.table(collection).set(id, { recordId: id, data: row, createdBy: actingUserId, createdAt: now, updatedAt: now })
    return { ok: true, recordId: id } satisfies WriteResult
  }

  async update(collection: string, recordId: string, patch: Record<string, unknown>, _actingUserId: string) {
    await tick()
    const existing = this.table(collection).get(recordId)
    if (!existing) return { ok: false, error: 'Record not found' } satisfies WriteResult
    const schema = this.schema(collection)
    const next = { ...existing.data }
    for (const col of schema.columns) {
      if (!(col.name in patch)) continue
      if (col.userBound) continue // kept, like the DO
      if (col.immutable && patch[col.name] !== existing.data[col.name]) {
        return { ok: false, error: `Cannot modify immutable field '${col.name}'` } satisfies WriteResult
      }
      next[col.name] = structuredClone(patch[col.name])
    }
    const dup = this.uniqueClash(collection, next, recordId)
    if (dup) return { ok: false, error: dup } satisfies WriteResult
    existing.data = next
    existing.updatedAt = new Date().toISOString()
    return { ok: true, recordId } satisfies WriteResult
  }

  async remove(collection: string, recordId: string, _actingUserId: string) {
    await tick()
    this.table(collection).delete(recordId)
    return { ok: true, recordId } satisfies WriteResult
  }

  private uniqueClash(collection: string, row: Record<string, unknown>, selfId: string | undefined) {
    const keys = this.schema(collection).uniqueOn
    if (!keys) return null
    for (const r of this.table(collection).values()) {
      if (r.recordId === selfId) continue
      if (keys.every((k) => r.data[k] === row[k])) {
        return `Duplicate: a record with ${keys.map((k) => `${k}=${String(row[k])}`).join(', ')} already exists in ${collection}`
      }
    }
    return null
  }
}

/** Emulates state.blockConcurrencyWhile: ops run strictly one after another. */
export function serialized() {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
