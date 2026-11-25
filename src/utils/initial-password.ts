const INITIAL_PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
// Largest multiple of the alphabet size below 256, so every character is equally likely.
const UNBIASED_LIMIT = 256 - (256 % INITIAL_PASSWORD_ALPHABET.length)

export function generateInitialPassword(length = 8) {
  let password = ''
  while (password.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < UNBIASED_LIMIT && password.length < length) {
        password += INITIAL_PASSWORD_ALPHABET[byte % INITIAL_PASSWORD_ALPHABET.length]
      }
    }
  }
  return password
}
