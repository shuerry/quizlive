import { describe, expect, it, vi } from 'vitest'
import { assertInProcessToolCall, checkLockDuration, SLOW_OP_MS } from './lock-guard'
import { toolsStore } from './do-store'
import engineSrc from './engine.ts?raw'
import scoringSrc from './scoring.ts?raw'
import doStoreSrc from './do-store.ts?raw'

const SOURCES: Record<string, string> = {
  './engine.ts': engineSrc,
  './scoring.ts': scoringSrc,
  './do-store.ts': doStoreSrc,
}
const src = (f: string) => SOURCES[f]

/** Code that runs inside blockConcurrencyWhile. */
const LOCKED_FILES = ['./engine.ts', './scoring.ts', './do-store.ts']
const ALLOWED_IMPORTS: Record<string, string[]> = {
  './engine.ts': ['./scoring'],
  './scoring.ts': [],
  './do-store.ts': ['./engine'],
}

describe('nothing slow runs inside blockConcurrencyWhile', () => {
  it.each(LOCKED_FILES)('%s imports only other lock-safe game files', (file) => {
    const imports = [...src(file).matchAll(/^import\s.*?from\s+'([^']+)'/gms)].map((m) => m[1])
    expect(imports.sort()).toEqual([...ALLOWED_IMPORTS[file]].sort())
  })

  it.each(LOCKED_FILES)('%s makes no network, AI or timer calls', (file) => {
    const code = src(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '') // ignore comments
    expect(code).not.toMatch(/\bfetch\s*\(/) // do-store's injected doFetch( is fine
    expect(code).not.toMatch(/\.integration\s*\(|\bintegration\(|\benv\.|setTimeout|setInterval|scheduler\.wait/)
  })

  it('the DO store refuses any request other than the in-process tools call', async () => {
    const store = toolsStore(async (req) => {
      assertInProcessToolCall(req)
      return Response.json({ success: true, data: { records: [] } })
    }, 'u')
    await expect(store.query('games', {})).resolves.toEqual([])

    expect(() => assertInProcessToolCall(new Request('https://api.anthropic.com/v1/messages', { method: 'POST' }))).toThrow(
      /lock-guard/,
    )
    expect(() => assertInProcessToolCall(new Request('https://internal/api/integrations/x', { method: 'POST' }))).toThrow(
      /lock-guard/,
    )
    expect(() => assertInProcessToolCall(new Request('https://internal/api/tools/execute'))).toThrow(/lock-guard/)
  })

  it('flags an op that holds the lock too long', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(checkLockDuration('reveal', SLOW_OP_MS)).toBe(true)
    expect(checkLockDuration('reveal', SLOW_OP_MS + 1)).toBe(false)
    expect(err).toHaveBeenCalledOnce()
    err.mockRestore()
  })
})
