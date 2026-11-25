import { prelogin } from '../api/auth.ts'
import { deriveFromPassword } from '../crypto/index.ts'

export type AuthKeyCredential = { authKey: string; wrapKey: CryptoKey }
export type AccountCredential = AuthKeyCredential

export async function credentialFor(username: string, password: string): Promise<AccountCredential> {
  const result = await prelogin(username)
  const derived = await deriveFromPassword(password, result.kdfSalt, result.kdfIterations)
  return { authKey: derived.authKey, wrapKey: derived.wrapKey }
}
