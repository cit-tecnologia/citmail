// Sessões do painel no Redis (ADR 0008; CIT-70). O cookie leva um id opaco de 32 bytes
// (base64url, 43 caracteres); o Redis só guarda o SHA-256 dele, na chave
// `<prefixo>:sessao:<hex>` e no conjunto `<prefixo>:sessoes:conta:<contaId>`.
// Prazos: 30 min de inatividade e 8 h absolutas, no TTL e conferidos de novo na leitura.
// `agora` (relógio) e `antesDeRenovar` (gancho entre a leitura e a renovação) só nos testes.
import { createHash, randomBytes } from 'node:crypto'

export const INATIVIDADE_MS = 30 * 60 * 1000
export const ABSOLUTO_MS = 8 * 60 * 60 * 1000
const ID_SESSAO = /^[A-Za-z0-9_-]{43}$/
const AGENTE_MAX = 256

export function hashDoId(id) {
  return createHash('sha256').update(id, 'utf8').digest('hex')
}

export function criarSessoes({ redis, prefixo, agora = Date.now, antesDeRenovar }) {
  const chave = (idHash) => `${prefixo}:sessao:${idHash}`
  const conjunto = (contaId) => `${prefixo}:sessoes:conta:${contaId}`

  // `exec()` de `multi`/`pipeline` não lança erro de comando: devolve pares `[erro, resultado]`.
  async function executar(lote) {
    const resultados = await lote.exec()
    const comErro = resultados?.find(([erro]) => erro)
    if (comErro) throw comErro[0]
    return resultados.map(([, resultado]) => resultado)
  }

  async function apagar(idHash, contaId) {
    const transacao = redis.multi().del(chave(idHash))
    if (contaId) transacao.srem(conjunto(contaId), idHash)
    await executar(transacao)
  }

  return {
    // Sem fila offline: com o Redis fora, a rota responde 503 antes do banco e do hash.
    pronto() {
      return redis.status === 'ready'
    },

    async criar({ contaId, clienteId, ip, agenteUsuario }) {
      const id = randomBytes(32).toString('base64url')
      const idHash = hashDoId(id)
      const instante = agora()
      const dados = {
        contaId,
        clienteId,
        criadoEm: instante,
        ultimoAcesso: instante,
        ip,
        agenteUsuario: String(agenteUsuario ?? '').slice(0, AGENTE_MAX)
      }
      const gravado = await redis.set(chave(idHash), JSON.stringify(dados), 'PX', INATIVIDADE_MS, 'NX')
      if (gravado !== 'OK') throw new Error('sessão não gravada')
      try {
        await executar(redis.multi().sadd(conjunto(contaId), idHash).pexpire(conjunto(contaId), ABSOLUTO_MS))
      } catch (erro) {
        // Sem sessão órfã: a chave sai (melhor esforço) antes de o erro subir.
        await redis.del(chave(idHash)).catch(() => {})
        throw erro
      }
      return id
    },

    // Devolve `{ idHash, dados }` ou null (id fora do formato, ausente ou vencida; a vencida é apagada).
    async ler(id) {
      if (typeof id !== 'string' || !ID_SESSAO.test(id)) return null
      const idHash = hashDoId(id)
      const texto = await redis.get(chave(idHash))
      if (texto === null) return null
      const dados = JSON.parse(texto)
      const instante = agora()
      if (instante - dados.ultimoAcesso > INATIVIDADE_MS || instante >= dados.criadoEm + ABSOLUTO_MS) {
        await apagar(idHash, dados.contaId)
        return null
      }
      return { idHash, dados }
    },

    // Só `SET XX`: um logout entre a leitura e a renovação não é desfeito (devolve false).
    async renovar({ idHash, dados }) {
      if (antesDeRenovar) await antesDeRenovar()
      const instante = agora()
      const ttl = Math.min(INATIVIDADE_MS, dados.criadoEm + ABSOLUTO_MS - instante)
      if (ttl <= 0) {
        await apagar(idHash, dados.contaId)
        return false
      }
      const novo = JSON.stringify({ ...dados, ultimoAcesso: instante })
      return (await redis.set(chave(idHash), novo, 'PX', ttl, 'XX')) === 'OK'
    },

    apagar,

    // Membros cujo `sessao:` já expirou saem do conjunto a cada login (EXISTS num só pipeline).
    async limparConjunto(contaId) {
      const membros = await redis.smembers(conjunto(contaId))
      if (membros.length === 0) return
      const lote = redis.pipeline()
      for (const membro of membros) lote.exists(chave(membro))
      const existentes = await executar(lote)
      const vencidos = membros.filter((_, indice) => existentes[indice] === 0)
      if (vencidos.length > 0) await redis.srem(conjunto(contaId), ...vencidos)
    },

    // Logout e troca de sessão no login: apaga a sessão do id, se existir.
    async encerrar(id) {
      if (typeof id !== 'string' || !ID_SESSAO.test(id)) return
      const idHash = hashDoId(id)
      const texto = await redis.get(chave(idHash))
      const contaId = texto === null ? undefined : JSON.parse(texto).contaId
      await apagar(idHash, contaId)
    }
  }
}
