import { randomUUID } from 'node:crypto'
import { stdin as input, stdout as output } from 'node:process'
import {
  base64UrlEncode,
  deriveFromPassword,
  generateKdfSalt,
  generateMasterKey,
  generateRecoveryKey,
  recoveryWrapKey,
  unwrapMasterKey,
  wrapMasterKey,
} from '../src/crypto/index.ts'

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/
export const DEFAULT_KDF_ITERATIONS = 600000
export const DEFAULT_PASSWORD_ITERATIONS = 100000

const encoder = new TextEncoder()

export function validateUsername(username) {
  return USERNAME_PATTERN.test(username)
}

export function validateRole(role) {
  return role === 'admin' || role === 'user'
}

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export function readHiddenPassword(question) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || !output.isTTY) {
      reject(new Error('请在交互式终端里运行这个命令。'))
      return
    }

    output.write(question)
    input.setRawMode(true)
    input.resume()
    let value = ''
    const onData = (chunk) => {
      const character = chunk.toString()
      if (character === '\r' || character === '\n') {
        input.setRawMode(false)
        input.pause()
        input.removeListener('data', onData)
        output.write('\n')
        resolve(value)
      } else if (character === '\u0003') {
        input.setRawMode(false)
        input.pause()
        input.removeListener('data', onData)
        reject(new Error('已取消。'))
      } else if (character === '\u007f') {
        value = value.slice(0, -1)
      } else {
        value += character
      }
    }
    input.on('data', onData)
  })
}

export async function hashAuthKey(authKey, iterations = DEFAULT_PASSWORD_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', encoder.encode(authKey), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  )
  return {
    hash: base64UrlEncode(new Uint8Array(bits)),
    salt: base64UrlEncode(salt),
    iterations,
  }
}

export async function buildUserRecord({
  username,
  role,
  password,
  id,
  kdfIterations = DEFAULT_KDF_ITERATIONS,
  now = new Date(),
}) {
  const userId = id ?? randomUUID()
  const kdfSalt = generateKdfSalt()
  const mk = generateMasterKey()
  const { wrapKey, authKey } = await deriveFromPassword(password, kdfSalt, kdfIterations)
  const passwordRecord = await hashAuthKey(authKey)
  const wrappedMasterKey = await wrapMasterKey(mk, wrapKey, userId)

  const recovery = generateRecoveryKey()
  const recoveryKey = await recoveryWrapKey(recovery.bytes)
  const recoveryWrappedKey = await wrapMasterKey(mk, recoveryKey, userId)

  const mkFromWrapKey = await unwrapMasterKey(wrappedMasterKey, wrapKey, userId)
  const mkFromRecovery = await unwrapMasterKey(recoveryWrappedKey, recoveryKey, userId)
  if (
    base64UrlEncode(mkFromWrapKey) !== base64UrlEncode(mk)
    || base64UrlEncode(mkFromRecovery) !== base64UrlEncode(mk)
  ) {
    throw new Error('生成的密钥自检失败，请重试。')
  }

  const timestamp = now.toISOString()
  return {
    id: userId,
    username,
    role,
    password_hash: passwordRecord.hash,
    password_salt: passwordRecord.salt,
    password_iterations: passwordRecord.iterations,
    kdf_salt: kdfSalt,
    kdf_iterations: kdfIterations,
    wrapped_master_key: wrappedMasterKey,
    recovery_wrapped_key: recoveryWrappedKey,
    keys_updated_at: timestamp,
    created_at: timestamp,
    recoveryCode: recovery.display,
  }
}

function userValues(record) {
  return `  ${sqlString(record.id)},
  ${sqlString(record.username)},
  ${sqlString(record.password_hash)},
  ${sqlString(record.password_salt)},
  ${record.password_iterations},
  ${sqlString(record.kdf_salt)},
  ${record.kdf_iterations},
  ${sqlString(record.wrapped_master_key)},
  ${sqlString(record.recovery_wrapped_key)},
  ${sqlString(record.keys_updated_at)},
  ${sqlString(record.created_at)},
  ${sqlString(record.created_at)},
  0,
  ${sqlString(record.role)},
  0`
}

export function userInsertSql(record) {
  return `INSERT INTO users (
  id, username, password_hash, password_salt, password_iterations,
  kdf_salt, kdf_iterations, wrapped_master_key, recovery_wrapped_key,
  keys_updated_at, created_at, updated_at, disabled, role, must_change_password
) VALUES (
${userValues(record)}
);
`
}

export function userUpsertSql(record) {
  return `INSERT INTO users (
  id, username, password_hash, password_salt, password_iterations,
  kdf_salt, kdf_iterations, wrapped_master_key, recovery_wrapped_key,
  keys_updated_at, created_at, updated_at, disabled, role, must_change_password
) VALUES (
${userValues(record)}
)
ON CONFLICT(username) DO UPDATE SET
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt,
  password_iterations = excluded.password_iterations,
  kdf_salt = excluded.kdf_salt,
  kdf_iterations = excluded.kdf_iterations,
  wrapped_master_key = excluded.wrapped_master_key,
  recovery_wrapped_key = excluded.recovery_wrapped_key,
  keys_updated_at = excluded.keys_updated_at,
  updated_at = excluded.updated_at,
  disabled = 0,
  role = excluded.role,
  must_change_password = 0;
`
}
