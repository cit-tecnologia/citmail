// Token de acompanhamento do pedido (ADR 0016; CIT-69): 32 bytes aleatórios em base64url
// sem `=` (43 caracteres). O banco guarda só o SHA-256 em hex; o token nunca vai a log.
import { createHash, randomBytes } from 'node:crypto'

const PADRAO_TOKEN = /^[A-Za-z0-9_-]{43}$/

export function gerarToken() {
  return randomBytes(32).toString('base64url')
}

export function tokenValido(token) {
  return typeof token === 'string' && PADRAO_TOKEN.test(token)
}

export function hashDoToken(token) {
  return createHash('sha256').update(token).digest('hex')
}
