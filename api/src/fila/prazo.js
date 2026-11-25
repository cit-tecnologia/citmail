// Prazo do `add`/`addBulk` (CIT-71: antes repetido no webhook, no e-mail e nas tarefas de
// domínio): com o Redis fora, o BullMQ espera a conexão indefinidamente.
import { LIMITE_PUBLICACAO_MS } from '../eventos/publicador.js'

export async function comPrazo(promessa) {
  let timer
  try {
    return await Promise.race([
      promessa,
      new Promise((_, rejeitar) => {
        timer = setTimeout(() => {
          rejeitar(Object.assign(new Error('limite da fila'), { name: 'TimeoutError' }))
        }, LIMITE_PUBLICACAO_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
