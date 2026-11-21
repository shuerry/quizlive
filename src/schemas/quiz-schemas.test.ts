import { describe, expect, it } from 'vitest'
import { canCreate, canDelete, canRead, canUpdate, lintSchemas } from 'deepspace/worker'
import { schemas } from '../schemas'
import {
  answerKeysSchema,
  answersSchema,
  gamesSchema,
  playersSchema,
  questionsSchema,
  quizSchemas,
  quizzesSchema,
  teamMembersSchema,
} from './quiz-schemas'

const HOST = 'user-host'
const PLAYER = 'user-player'
const OTHER = 'user-outsider'
const GAME = 'game-1'

const ROLES = ['member', 'admin', 'viewer', '*'] as const

// Membership as the Durable Object would resolve it from team_members.
const members = new Map<string, Set<string>>([[GAME, new Set([HOST, PLAYER])]])
const ctx = { isTeamMember: (teamId: string, userId: string) => !!members.get(teamId)?.has(userId) }

const rec = (createdBy: string, data: Record<string, unknown>) => ({
  recordId: 'r1',
  createdBy,
  data,
  createdAt: '',
  updatedAt: '',
})

describe('schema set', () => {
  it('registers users plus every DESIGN.md collection', () => {
    const names = schemas.map((s) => s.name)
    for (const n of ['users', 'quizzes', 'questions', 'answerKeys', 'games', 'players', 'answers']) {
      expect(names).toContain(n)
    }
  })

  it('passes the SDK schema lint with no warnings', () => {
    expect(lintSchemas(schemas)).toEqual([])
  })

  it('stamps every identity column from the verified caller and never lets it change', () => {
    for (const s of quizSchemas) {
      const owner = s.columns.find((c) => c.name === s.ownerField)
      expect(owner, s.name).toMatchObject({ userBound: true, immutable: true, storage: 'text' })
    }
  })

  it('gives admin exactly the member rules (no owner back door)', () => {
    for (const s of quizSchemas) expect(s.permissions.admin, s.name).toEqual(s.permissions.member)
  })

  it('gives anonymous and viewer nothing', () => {
    for (const s of quizSchemas) {
      for (const role of ['*', 'viewer']) {
        expect(s.permissions[role], `${s.name}/${role}`).toEqual({
          read: false,
          create: false,
          update: false,
          delete: false,
        })
      }
    }
  })
})

describe('answerKeys: host only, ever', () => {
  const key = rec(HOST, { questionId: 'q1', correctIndex: 2, hostId: HOST })

  it('the host can read their own key', () => {
    expect(canRead(answerKeysSchema, 'member', key, HOST, ctx)).toBe(true)
  })

  it('no one else can read it, in any role, even while in the same game', () => {
    for (const role of ROLES) {
      for (const user of [PLAYER, OTHER, '']) {
        expect(canRead(answerKeysSchema, role, key, user, ctx), `${role}/${user}`).toBe(false)
      }
    }
  })

  it('no client role can create, update or delete keys directly', () => {
    for (const role of ROLES) {
      expect(canCreate(answerKeysSchema, role)).toBe(false)
      expect(canUpdate(answerKeysSchema, role, key, HOST, ctx)).toBe(false)
      expect(canDelete(answerKeysSchema, role, key, HOST, ctx)).toBe(false)
    }
  })
})

describe('questions: host only', () => {
  const q = rec(HOST, { quizId: 'z', order: 0, prompt: 'p', choices: ['a', 'b'], timeLimitSec: 20, hostId: HOST })

  it('host reads, players and outsiders do not', () => {
    expect(canRead(questionsSchema, 'member', q, HOST, ctx)).toBe(true)
    for (const role of ROLES) {
      expect(canRead(questionsSchema, role, q, PLAYER, ctx)).toBe(false)
      expect(canRead(questionsSchema, role, q, OTHER, ctx)).toBe(false)
    }
  })
})

describe('quizzes: host only', () => {
  const quiz = rec(HOST, { title: 't', hostId: HOST })

  it('host reads and edits, others do not', () => {
    expect(canRead(quizzesSchema, 'member', quiz, HOST, ctx)).toBe(true)
    expect(canUpdate(quizzesSchema, 'member', quiz, HOST, ctx)).toBe(true)
    expect(canRead(quizzesSchema, 'member', quiz, PLAYER, ctx)).toBe(false)
    expect(canUpdate(quizzesSchema, 'member', quiz, PLAYER, ctx)).toBe(false)
  })

  it('clients may only write the title', () => {
    expect(quizzesSchema.permissions.member.writableFields).toEqual(['title'])
  })
})

describe('games and players: everyone in the game', () => {
  const game = rec(HOST, { quizId: 'z', hostId: HOST, code: 'ABC123', teamId: GAME })
  const player = rec(PLAYER, { gameId: GAME, userId: PLAYER, nickname: 'n', score: 0 })

  it('host and joined players read; outsiders do not', () => {
    for (const s of [gamesSchema, playersSchema]) {
      const r = s === gamesSchema ? game : player
      expect(canRead(s, 'member', r, HOST, ctx), s.name).toBe(true)
      expect(canRead(s, 'member', r, PLAYER, ctx), s.name).toBe(true)
      expect(canRead(s, 'member', r, OTHER, ctx), s.name).toBe(false)
      expect(canRead(s, 'admin', r, OTHER, ctx), s.name).toBe(false)
    }
  })

  it('no client can write them (state, clock and scores are server-owned)', () => {
    for (const s of [gamesSchema, playersSchema, teamMembersSchema]) {
      const r = s === gamesSchema ? game : player
      for (const role of ROLES) {
        expect(canCreate(s, role), s.name).toBe(false)
        expect(canUpdate(s, role, r, HOST, ctx), s.name).toBe(false)
        expect(canUpdate(s, role, r, PLAYER, ctx), s.name).toBe(false)
      }
    }
  })
})

describe('answers: own answer only', () => {
  const mine = rec(PLAYER, { gameId: GAME, questionId: 'q1', userId: PLAYER, choice: 1, receivedAt: 1 })

  it('the answering player reads it; the host and other players do not', () => {
    expect(canRead(answersSchema, 'member', mine, PLAYER, ctx)).toBe(true)
    expect(canRead(answersSchema, 'member', mine, HOST, ctx)).toBe(false)
    expect(canRead(answersSchema, 'admin', mine, HOST, ctx)).toBe(false)
    expect(canRead(answersSchema, 'member', mine, OTHER, ctx)).toBe(false)
  })

  it('one answer per player per question', () => {
    expect(answersSchema.uniqueOn).toEqual(['gameId', 'questionId', 'userId'])
  })

  it('answers are written only by the server (timestamped there)', () => {
    for (const role of ROLES) expect(canCreate(answersSchema, role)).toBe(false)
  })
})
