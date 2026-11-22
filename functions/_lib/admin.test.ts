import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { PagesFunction } from '@cloudflare/workers-types'
import type { AuthRepository, StoredUser, UserSummary } from './auth-repository.ts'
import { AuthRepositoryConflictError } from './auth-repository.ts'
import { createAdminUsersHandler } from '../api/admin/users/index.ts'
import { createAdminUserHandler } from '../api/admin/users/[id].ts'
import { createAdminPasswordHandler } from '../api/admin/users/[id]/password.ts'

const adminId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'

function inMemoryRepository(options: {
  authenticated?: StoredUser | null
  users?: UserSummary[]
  duplicate?: boolean
} = {}) {
  const authenticated = options.authenticated ?? null
  const users = new Map((options.users ?? []).map((user) => [user.id, user]))
  const revoked: string[] = []
  const revokedOther: string[] = []
  let passwordUpdates = 0

  const repository: AuthRepository = {
    findUser: async (username) => authenticated?.username === username ? authenticated : null,
    findSessionUser: async () => authenticated
      ? {
        session_id: 'session-1',
        id: authenticated.id,
        username: authenticated.username,
        role: authenticated.role,
        must_change_password: authenticated.must_change_password,
      }
      : null,
    touchSession: async () => undefined,
    findLoginAttempt: async () => null,
    recordLoginFailure: async () => undefined,
    clearLoginFailures: async () => undefined,
    createSession: async () => undefined,
    deleteSessionByTokenHash: async () => undefined,
    revokeAllSessions: async (id) => { revoked.push(id) },
    listUsers: async () => [...users.values()],
    findUserById: async (id) => users.get(id) ?? null,
    createUser: async (input) => {
      if (options.duplicate || [...users.values()].some((user) => user.username.toLowerCase() === input.username.toLowerCase())) {
        throw new AuthRepositoryConflictError('username_taken')
      }
      const user: UserSummary = {
        id: input.id,
        username: input.username,
        role: input.role,
        disabled: 0,
        must_change_password: input.mustChangePassword,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      }
      users.set(user.id, user)
      return user
    },
    updatePassword: async (id, _hash, _salt, _iterations, mustChangePassword, updatedAt) => {
      passwordUpdates += 1
      const user = users.get(id)
      if (user) users.set(id, { ...user, must_change_password: mustChangePassword, updated_at: updatedAt })
    },
    setDisabled: async (id, disabled, updatedAt) => {
      const user = users.get(id)
      if (user) users.set(id, { ...user, disabled, updated_at: updatedAt })
    },
    revokeOtherSessions: async (id, keepId) => { revokedOther.push(`${id}:${keepId}`) },
  }
  return { repository, users, revoked, revokedOther, get passwordUpdates() { return passwordUpdates } }
}

function env() {
  return { DB: {} as D1Database }
}

function request(method: string, body?: unknown) {
  return new Request(`https://cloudhub.test/api/admin/users`, {
    method,
    headers: {
      Cookie: 'cloudhub_session=valid-token',
      Origin: 'https://cloudhub.test',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function call(handler: PagesFunction<{ DB?: D1Database }>, method: string, body?: unknown, params: Record<string, string> = {}) {
  return handler({ request: request(method, body), env: env(), params } as never)
}

test('admin users enforces authentication and admin role', async () => {
  const anonymous = inMemoryRepository()
  let response = await call(createAdminUsersHandler({ createAuthRepository: () => anonymous.repository }), 'GET')
  assert.equal(response.status, 401)

  const ordinary = inMemoryRepository({
    authenticated: {
      id: userId, username: 'alice', password_hash: 'x', password_salt: 'x', password_iterations: 100000,
      disabled: 0, role: 'user', must_change_password: 0,
    },
  })
  response = await call(createAdminUsersHandler({ createAuthRepository: () => ordinary.repository }), 'GET')
  assert.equal(response.status, 403)

  const pendingAdmin = inMemoryRepository({
    authenticated: {
      id: adminId, username: 'root', password_hash: 'x', password_salt: 'x', password_iterations: 100000,
      disabled: 0, role: 'admin', must_change_password: 1,
    },
  })
  response = await call(createAdminUsersHandler({ createAuthRepository: () => pendingAdmin.repository }), 'GET')
  assert.equal(response.status, 403)
})

test('admin can create a user without exposing password fields and rejects invalid or duplicate users', async () => {
  const current = inMemoryRepository({
    authenticated: {
      id: adminId, username: 'root', password_hash: 'x', password_salt: 'x', password_iterations: 100000,
      disabled: 0, role: 'admin', must_change_password: 0,
    },
  })
  const handler = createAdminUsersHandler({ createAuthRepository: () => current.repository })

  let response = await call(handler, 'POST', { username: 'bad name', password: 'twelvechars12' })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_request' })

  response = await call(handler, 'POST', { username: 'alice', password: 'short' })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'weak_password' })

  response = await call(handler, 'POST', { username: 'alice', password: 'twelvechars12' })
  assert.equal(response.status, 201)
  const body = await response.json() as { user: Record<string, unknown> }
  assert.equal(body.user.must_change_password, 1)
  assert.equal('password_hash' in body.user, false)
  assert.equal('password_salt' in body.user, false)

  const duplicate = inMemoryRepository({ duplicate: true, authenticated: {
    id: adminId, username: 'root', password_hash: 'x', password_salt: 'x', password_iterations: 100000,
    disabled: 0, role: 'admin', must_change_password: 0,
  } })
  response = await call(createAdminUsersHandler({ createAuthRepository: () => duplicate.repository }), 'POST', { username: 'alice', password: 'twelvechars12' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'username_taken' })

  const listResponse = await call(handler, 'GET')
  const listBody = await listResponse.json() as { users: Array<Record<string, unknown>> }
  assert.ok(listBody.users.every((user) => !('password_hash' in user) && !('password_salt' in user)))
})

test('admin can disable a user and reset password only for non-admin targets', async () => {
  const target: UserSummary = {
    id: userId, username: 'alice', role: 'user', disabled: 0,
    must_change_password: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
  const current = inMemoryRepository({
    authenticated: {
      id: adminId, username: 'root', password_hash: 'x', password_salt: 'x', password_iterations: 100000,
      disabled: 0, role: 'admin', must_change_password: 0,
    },
    users: [target],
  })

  const disable = createAdminUserHandler({ createAuthRepository: () => current.repository })
  let response = await call(disable as never, 'PATCH', { disabled: true }, { id: userId })
  assert.equal(response.status, 200)
  assert.deepEqual(current.revoked, [userId])

  response = await call(disable as never, 'PATCH', { disabled: true }, { id: 'missing' })
  assert.equal(response.status, 404)

  const reset = createAdminPasswordHandler({ createAuthRepository: () => current.repository })
  response = await call(reset as never, 'POST', { password: 'twelvechars12' }, { id: userId })
  assert.equal(response.status, 200)
  assert.equal(current.passwordUpdates, 1)
  assert.equal(current.users.get(userId)?.must_change_password, 1)
  assert.deepEqual(current.revoked, [userId, userId])

  const adminTarget = inMemoryRepository({
    authenticated: {
      id: adminId, username: 'root', password_hash: 'x', password_salt: 'x', password_iterations: 100000,
      disabled: 0, role: 'admin', must_change_password: 0,
    },
    users: [{ ...target, id: adminId, username: 'root', role: 'admin' }],
  })
  response = await call(createAdminPasswordHandler({ createAuthRepository: () => adminTarget.repository }) as never, 'POST', { password: 'twelvechars12' }, { id: adminId })
  assert.equal(response.status, 403)
})

