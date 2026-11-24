// Registro dos modelos de e-mail (ADR 0010; CIT-65), versionados no repositório.
// Cada modelo: `{ versao, carregar(cliente, refs, { log }) → { destinatario, variaveis } | null,
// assunto(v), html(v), texto(v) }`. `carregar` lê do banco, no momento do envio, o
// destinatário e as variáveis a partir de `refs` (só ids); `log` (do job) serve para o
// motivo, em código, de devolver `null`. `html` devolve o resultado do
// tagged template `html` (escape automático); `assunto` e `texto` passam por `limparLinha`.
// O nome do modelo é a chave do registro (sem hífen; mesmo formato do CHECK da tabela).
import { compraConfirmada } from './compra-confirmada.js'
import { testeExemplo } from './teste-exemplo.js'

const NOME_MODELO = /^[a-z][a-z0-9_]{0,47}$/

/**
 * Modelos de produção: `compra_confirmada` (CIT-66). Credenciais e avisos chegam com as
 * histórias #102 e #72.
 */
export const modelosPadrao = Object.freeze({ compra_confirmada: compraConfirmada })

/** Modelos fora de produção: os de produção e o `teste_exemplo` (como o `jobExemplo`). */
export const modelosForaDeProducao = Object.freeze({ ...modelosPadrao, teste_exemplo: testeExemplo })

// `nodeEnv` ausente conta como produção (falha fechada, como em config.js).
export function modelosDoAmbiente(nodeEnv) {
  return (nodeEnv || 'production') === 'production' ? modelosPadrao : modelosForaDeProducao
}

function invalido(motivo) {
  return new TypeError(`modelos: ${motivo}`)
}

/**
 * Confere o registro e lança TypeError no primeiro problema: nome fora do formato,
 * `versao` que não é inteiro ≥ 1, `carregar`, `assunto`, `html` ou `texto` ausente.
 */
export function validarModelos(modelos) {
  if (typeof modelos !== 'object' || modelos === null || Array.isArray(modelos)) {
    throw invalido('registro inválido')
  }
  for (const [nome, modelo] of Object.entries(modelos)) {
    if (!NOME_MODELO.test(nome)) throw invalido(`nome inválido: ${nome.slice(0, 64)}`)
    if (!Number.isInteger(modelo?.versao) || modelo.versao < 1) throw invalido(`${nome}: versao inválida`)
    for (const funcao of ['carregar', 'assunto', 'html', 'texto']) {
      if (typeof modelo[funcao] !== 'function') throw invalido(`${nome}: ${funcao} ausente`)
    }
  }
}

validarModelos(modelosForaDeProducao)
