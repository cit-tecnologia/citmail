// Hash da senha do painel (ADR 0008; CIT-70): Argon2id com parâmetros sempre explícitos,
// nunca o padrão da biblioteca. O `Algorithm` do `@node-rs/argon2` é `const enum` do
// TypeScript e não existe em tempo de execução: 2 = Argon2id.
import { hash, verify } from '@node-rs/argon2'

export const PARAMETROS_ARGON2 = Object.freeze({ algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 })

// Hash de um valor aleatório descartado, com os mesmos parâmetros: e-mail inexistente ou
// conta sem login faz a mesma verificação que a conta ativa (mesmo custo de tempo).
export const HASH_FALSO = '$argon2id$v=19$m=19456,t=2,p=1$+/tx+W37RPdYpKrjQptaGA$2dCKFkKhqOR2D/ZcyhQL0D+h6RGsG6N3lRpLKYg8Yj4'

export function gerarHashSenha(senha) {
  return hash(senha, PARAMETROS_ARGON2)
}

// Hash malformado no banco conta como senha errada, sem 500. A verificação contra o hash
// falso (resultado ignorado) mantém o tempo da resposta igual ao das outras recusas.
export async function verificarSenha(hashArmazenado, senha) {
  try {
    return await verify(hashArmazenado, senha)
  } catch {
    await verify(HASH_FALSO, senha).catch(() => {})
    return false
  }
}

export const hashPadrao = Object.freeze({ verificar: verificarSenha })
