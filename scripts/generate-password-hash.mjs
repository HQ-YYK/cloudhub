import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { webcrypto } from 'node:crypto'

const ITERATIONS = 310000
const encoder = new TextEncoder()

function readHidden(question) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || !output.isTTY) {
      reject(new Error('Run this command in an interactive terminal.'))
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
        reject(new Error('Cancelled.'))
      } else if (character === '\u007f') {
        value = value.slice(0, -1)
      } else {
        value += character
      }
    }
    input.on('data', onData)
  })
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

try {
  const readline = createInterface({ input, output })
  const username = (await readline.question('Username (not a password): ')).trim()
  readline.close()
  const password = await readHidden('Password (input hidden): ')
  if (!username || !password) throw new Error('Username and password are required.')

  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )

  console.log(JSON.stringify({
    username,
    password_hash: base64Url(new Uint8Array(bits)),
    password_salt: base64Url(salt),
    password_iterations: ITERATIONS,
  }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to generate password hash.')
  process.exitCode = 1
}
