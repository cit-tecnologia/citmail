// Job de exemplo (só fora de produção): fixa o padrão de log correlacionado de jobs.
export async function jobExemplo({ log }, { falhar = false } = {}) {
  log.info('processando exemplo')
  if (falhar) {
    throw new Error('falha simulada do job de exemplo')
  }
}
