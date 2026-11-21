/**
 * POST /api/quiz/draft-from-file  (multipart: file, quizId, count)
 *
 * Same trust model as /api/actions: the caller's JWT is verified here and its
 * subject is the only identity used. The file is read into memory, its text
 * extracted, and the bytes dropped at the end of the request. Nothing is
 * written to storage. See src/actions/draft-file.ts for the pipeline.
 */

import type { Hono } from 'hono'
import type { AppContext } from '../../worker.js'
import { draftDeps } from '../actions/index.js'
import { runDraftFromFile } from '../actions/draft-file.js'
import { MAX_UPLOAD_BYTES } from '../game/file-text.js'
import { createActionTools } from './action-routes.js'
import { resolveAuth } from './http-routes.js'

/** Multipart framing on top of the file itself. */
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
          error: `That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Upload a smaller PDF or paste the text.`,
        },
        413,
      )
    // Refuse early on the declared size; the parsed file is checked again below.
    const declared = Number(c.req.header('Content-Length') ?? '0')
    if (declared > MAX_UPLOAD_BYTES + MULTIPART_SLACK) return tooLarge()

    let form: FormData
    try {
      form = await c.req.raw.formData()
    } catch {
      return c.json({ success: false, code: 'bad_request', error: 'Upload a file using the form.' }, 400)
    }
    const file = form.get('file')
    const blob = file && typeof file === 'object' ? (file as File) : null
    if (blob && blob.size > MAX_UPLOAD_BYTES) return tooLarge()

    console.info(`[draft-file] caller=${auth.userId} bytes=${blob?.size ?? 0}`)
    const result = await runDraftFromFile(
      {
        quizId: form.get('quizId'),
        count: form.get('count'),
        fileName: blob?.name,
        bytes: blob ? new Uint8Array(await blob.arrayBuffer()) : null,
      },
      draftDeps(c.env, auth.userId, createActionTools(c.env, auth.userId, callerJwt)),
    )
    return c.json(result)
  })
}
