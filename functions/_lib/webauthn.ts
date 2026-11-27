import { constantTimeEqual, sha256 } from './auth.ts'

const encoder = new TextEncoder()

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

export const ES256 = -7
export const RS256 = -257

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return null
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function encodeBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value))
}

export function createWebauthnChallenge(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export function isValidPrfWrappedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value)
}

export function parseTransportsJson(value: string | null): string[] | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return null
    return parsed
  } catch {
    return null
  }
}

interface AuthenticatorData {
  rpIdHash: Uint8Array
  flags: number
  signCount: number
  attested: { aaguid: Uint8Array, credentialId: Uint8Array } | null
}

interface ClientDataJSON {
  type: string
  challenge: string
  origin: string
  crossOrigin: boolean
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number, next: number } | null {
  const first = bytes[offset]
  if (first === undefined) return null
  if (first < 0x80) return { length: first, next: offset + 1 }
  const count = first & 0x7f
  if (count === 0 || count > 2 || offset + 1 + count > bytes.length) return null
  let length = 0
  for (let index = 0; index < count; index += 1) {
    length = length * 256 + bytes[offset + 1 + index]
  }
  return { length, next: offset + 1 + count }
}

function readDerInteger(bytes: Uint8Array, offset: number): { value: Uint8Array, next: number } | null {
  if (bytes[offset] !== 0x02) return null
  const lengthInfo = readDerLength(bytes, offset + 1)
  if (!lengthInfo || lengthInfo.length === 0) return null
  const valueStart = lengthInfo.next
  if (valueStart + lengthInfo.length > bytes.length) return null
  let value = bytes.slice(valueStart, valueStart + lengthInfo.length)
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start += 1
  value = value.slice(start)
  return { value, next: valueStart + lengthInfo.length }
}

export function derToRawSignature(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30) return null
  const sequenceLength = readDerLength(der, 1)
  if (!sequenceLength || sequenceLength.next + sequenceLength.length !== der.length) return null
  const r = readDerInteger(der, sequenceLength.next)
  if (!r) return null
  const s = readDerInteger(der, r.next)
  if (!s || s.next !== der.length) return null
  if (r.value.length > 32 || s.value.length > 32) return null
  const raw = new Uint8Array(64)
  raw.set(r.value, 32 - r.value.length)
  raw.set(s.value, 64 - s.value.length)
  return raw
}

function parseAuthenticatorData(data: Uint8Array, expectAttestation: boolean): AuthenticatorData | null {
  if (data.length < 37) return null
  const rpIdHash = data.slice(0, 32)
  const flags = data[32]
  const signCount = data[33] * 0x1000000 + data[34] * 0x10000 + data[35] * 0x100 + data[36]
  let attested: AuthenticatorData['attested'] = null
  if (flags & FLAG_AT) {
    if (data.length < 55) return null
    const aaguid = data.slice(37, 53)
    const credentialIdLength = data[53] * 0x100 + data[54]
    const credentialIdStart = 55
    if (credentialIdStart + credentialIdLength > data.length) return null
    attested = {
      aaguid,
      credentialId: data.slice(credentialIdStart, credentialIdStart + credentialIdLength),
    }
  }
  if (expectAttestation && !attested) return null
  return { rpIdHash, flags, signCount, attested }
}

function parseClientDataJSON(raw: string): ClientDataJSON | null {
  const bytes = base64UrlToBytes(raw)
  if (!bytes) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const object = parsed as Record<string, unknown>
  if (typeof object.type !== 'string') return null
  if (typeof object.challenge !== 'string') return null
  if (typeof object.origin !== 'string') return null
  return {
    type: object.type,
    challenge: object.challenge,
    origin: object.origin,
    crossOrigin: object.crossOrigin === true,
  }
}

async function importPublicKey(algorithm: number, spki: Uint8Array): Promise<CryptoKey | null> {
  try {
    if (algorithm === ES256) {
      return await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    }
    if (algorithm === RS256) {
      return await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    }
    return null
  } catch {
    return null
  }
}

async function verifyEs256(spki: Uint8Array, signedData: Uint8Array, derSignature: Uint8Array): Promise<boolean> {
  const raw = derToRawSignature(derSignature)
  if (!raw) return false
  const key = await importPublicKey(ES256, spki)
  if (!key) return false
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signedData)
  } catch {
    return false
  }
}

async function verifyRs256(spki: Uint8Array, signedData: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await importPublicKey(RS256, spki)
  if (!key) return false
  try {
    return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signedData)
  } catch {
    return false
  }
}

async function verifySignature(
  algorithm: number,
  spki: Uint8Array,
  signedData: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (algorithm === ES256) return verifyEs256(spki, signedData, signature)
  if (algorithm === RS256) return verifyRs256(spki, signedData, signature)
  return false
}

export type RegistrationResult = 'ok' | 'unsupported_algorithm' | 'invalid_passkey' | 'invalid'

export interface RegistrationInput {
  rpId: string
  origin: string
  challengeHash: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  publicKeySpki: string
  algorithm: number
}

export async function verifyRegistration(input: RegistrationInput): Promise<RegistrationResult> {
  if (input.algorithm !== ES256 && input.algorithm !== RS256) return 'unsupported_algorithm'

  const clientData = parseClientDataJSON(input.clientDataJSON)
  if (!clientData) return 'invalid'
  if (clientData.type !== 'webauthn.create') return 'invalid'
  if (clientData.origin !== input.origin) return 'invalid'
  if (clientData.crossOrigin) return 'invalid'
  if (await sha256(clientData.challenge) !== input.challengeHash) return 'invalid'

  const authenticatorData = base64UrlToBytes(input.authenticatorData)
  if (!authenticatorData) return 'invalid'
  const authData = parseAuthenticatorData(authenticatorData, true)
  if (!authData || !authData.attested) return 'invalid'
  if (!(authData.flags & FLAG_UP) || !(authData.flags & FLAG_UV)) return 'invalid'

  const expectedRpIdHash = await sha256Bytes(encoder.encode(input.rpId))
  if (!constantTimeEqual(authData.rpIdHash, expectedRpIdHash)) return 'invalid'

  const credentialId = base64UrlToBytes(input.credentialId)
  if (!credentialId || !constantTimeEqual(authData.attested.credentialId, credentialId)) return 'invalid'

  const spki = base64UrlToBytes(input.publicKeySpki)
  if (!spki) return 'invalid_passkey'
  if (!(await importPublicKey(input.algorithm, spki))) return 'invalid_passkey'

  return 'ok'
}

export interface LoginAssertionInput {
  rpId: string
  origin: string
  challengeHash: string
  publicKeySpki: string
  algorithm: number
  signCount: number
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle: string
  expectedUserHandle: string
}

export async function verifyLoginAssertion(input: LoginAssertionInput): Promise<number | null> {
  const clientData = parseClientDataJSON(input.clientDataJSON)
  if (!clientData) return null
  if (clientData.type !== 'webauthn.get') return null
  if (clientData.origin !== input.origin) return null
  if (clientData.crossOrigin) return null
  if (await sha256(clientData.challenge) !== input.challengeHash) return null

  const authenticatorData = base64UrlToBytes(input.authenticatorData)
  if (!authenticatorData) return null
  const authData = parseAuthenticatorData(authenticatorData, false)
  if (!authData) return null
  if (!(authData.flags & FLAG_UP) || !(authData.flags & FLAG_UV)) return null

  const expectedRpIdHash = await sha256Bytes(encoder.encode(input.rpId))
  if (!constantTimeEqual(authData.rpIdHash, expectedRpIdHash)) return null

  if (input.userHandle !== input.expectedUserHandle) return null

  const bothZero = input.signCount === 0 && authData.signCount === 0
  if (!bothZero && authData.signCount <= input.signCount) return null

  const clientDataBytes = base64UrlToBytes(input.clientDataJSON)
  if (!clientDataBytes) return null
  const clientDataHash = await sha256Bytes(clientDataBytes)
  const signedData = new Uint8Array(authenticatorData.length + clientDataHash.length)
  signedData.set(authenticatorData, 0)
  signedData.set(clientDataHash, authenticatorData.length)

  const signature = base64UrlToBytes(input.signature)
  if (!signature) return null
  const spki = base64UrlToBytes(input.publicKeySpki)
  if (!spki) return null

  if (!(await verifySignature(input.algorithm, spki, signedData, signature))) return null

  return authData.signCount
}
