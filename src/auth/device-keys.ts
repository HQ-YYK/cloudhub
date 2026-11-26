import { base64UrlDecode, base64UrlEncode, CryptoError } from '../crypto/index.ts'
import { aesGcmDecrypt, aesGcmEncrypt } from '../crypto/keys.ts'

const DB_NAME = 'cloudhub'
const STORE_NAME = 'device-keys'

export type DeviceKeyRecord = {
  userId: string
  deviceKey: CryptoKey
  wrappedMk: string
}

function deviceAad(userId: string): string {
  return `cloudhub/v1/device:${userId}`
}

// Pure decision: when should a stored record be discarded relative to the current user?
export function shouldDeleteDeviceRecord(storedUserId: string | null, currentUserId: string | null): boolean {
  if (storedUserId === null) return false
  return storedUserId !== currentUserId
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'userId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('idb_open_failed'))
  })
}

async function deviceRecordGet(userId: string): Promise<DeviceKeyRecord | null> {
  const db = await openDb()
  try {
    return await new Promise<DeviceKeyRecord | null>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(userId)
      request.onsuccess = () => resolve((request.result as DeviceKeyRecord | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('idb_read_failed'))
    })
  } finally {
    db.close()
  }
}

async function deviceRecordSet(record: DeviceKeyRecord): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(record)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('idb_write_failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('idb_write_failed'))
    })
  } finally {
    db.close()
  }
}

async function deviceRecordDelete(userId: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(userId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('idb_delete_failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('idb_delete_failed'))
    })
  } finally {
    db.close()
  }
}

async function deviceRecordClear(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).clear()
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('idb_clear_failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('idb_clear_failed'))
    })
  } finally {
    db.close()
  }
}

export async function storeDeviceKeys(userId: string, mk: Uint8Array<ArrayBuffer>): Promise<void> {
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const wrappedMk = base64UrlEncode(await aesGcmEncrypt(deviceKey, deviceAad(userId), mk))
  await deviceRecordSet({ userId, deviceKey, wrappedMk })
}

export async function loadDeviceMk(userId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const record = await deviceRecordGet(userId)
  if (!record) return null
  try {
    const mk = await aesGcmDecrypt(record.deviceKey, deviceAad(userId), base64UrlDecode(record.wrappedMk))
    if (mk.length !== 32) throw new CryptoError('decrypt_failed')
    return mk
  } catch {
    await deviceRecordDelete(userId)
    return null
  }
}

export async function clearDeviceKeys(userId?: string): Promise<void> {
  if (userId) await deviceRecordDelete(userId)
  else await deviceRecordClear()
}

export async function hasDeviceKeys(userId: string): Promise<boolean> {
  return (await deviceRecordGet(userId)) !== null
}
