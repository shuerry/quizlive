/**
 * POST /api/quiz/draft-from-file  (multipart: up to 3 × file, quizId, count)
 *
 * Same trust model as /api/actions: the caller's JWT is verified here and its
 * subject is the only identity used. The files are read into memory, their text
 * extracted, and the bytes dropped at the end of the request. Nothing is
 * written to storage. See src/actions/draft-file.ts for the pipeline.
 */

import type { Hono } from 'hono'
import type { AppContext } from '../../worker.js'
import { draftDeps } from '../actions/index.js'
import { runDraftFromFiles } from '../actions/draft-file.js'
import { MAX_FILES, MAX_UPLOAD_BYTES } from '../game/file-text.js'
import { createActionTools } from './action-routes.js'
import { resolveAuth } from './http-routes.js'

/** Multipart framing on top of the files themselves. */
const MULTIPART_SLACK = 64 * 1024

export function registerUploadRoutes(app: Hono<AppContext>): void {
  app.post('/api/quiz/draft-from-file', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    const header = c.req.header('Authorization') ?? ''
    const callerJwt = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!auth || !callerJwt) return c.json({ success: false, code: 'unauthorized', error: 'Sign in first' }, 401)

    const tooLarge = () =>
      c.json(
        {
          success: false,
          code: 'too_large',
          error: `Uploads are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB in total. Upload fewer or smaller files.`,
        },
        413,
      )
    // Refuse early on the declared size; the parsed files are checked again below.
    const declared = Number(c.req.header('Content-Length') ?? '0')
    if (declared > MAX_UPLOAD_BYTES + MULTIPART_SLACK) return tooLarge()

    let form: FormData
    try {
      form = await c.req.raw.formData()
    } catch {
      return c.json({ success: false, code: 'bad_request', error: 'Upload a file using the form.' }, 400)
    }
    const blobs = form.getAll('file').filter((f): f is File => typeof f === 'object' && f !== null)
    // Check count and total size BEFORE reading any bytes.
    if (blobs.length > MAX_FILES) {
      return c.json(
        { success: false, code: 'too_many_files', error: `Upload at most ${MAX_FILES} files at a time (you chose ${blobs.length}).` },
        400,
      )
    }
    if (blobs.reduce((n, b) => n + b.size, 0) > MAX_UPLOAD_BYTES) return tooLarge()

    console.info(`[draft-file] caller=${auth.userId} files=${blobs.length} bytes=${blobs.map((b) => b.size).join('+') || 0}`)
    const files = await Promise.all(blobs.map(async (b) => ({ name: b.name, bytes: new Uint8Array(await b.arrayBuffer()) })))
    const result = await runDraftFromFiles(
      { quizId: form.get('quizId'), count: form.get('count'), files },
      draftDeps(c.env, auth.userId, createActionTools(c.env, auth.userId, callerJwt)),
    )
    return c.json(result)
  })
}
