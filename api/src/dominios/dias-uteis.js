// Datas locais e dias úteis das tarefas de domínio (CIT-77). A data é sempre a local de
// America/Sao_Paulo, obtida por `Intl.DateTimeFormat` (sem offset fixo: robusto a uma
// eventual volta do horário de verão). Dia útil é de segunda a sexta, sem feriados.

export const FUSO = 'America/Sao_Paulo'

// `en-CA` formata como `AAAA-MM-DD`.
const FORMATO_DATA = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' })

const DIA_MS = 86400000

/** Data local (`AAAA-MM-DD`) do instante (Date, número ou texto ISO). */
export function dataLocal(instante) {
  return FORMATO_DATA.format(new Date(instante))
}

// Meia-noite UTC da data `AAAA-MM-DD`: só para aritmética de calendário.
function emUtc(data) {
  const [ano, mes, dia] = data.split('-').map(Number)
  return Date.UTC(ano, mes - 1, dia)
}

function deUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Data `AAAA-MM-DD` somada de `dias` (negativo subtrai). */
export function somarDias(data, dias) {
  return deUtc(emUtc(data) + dias * DIA_MS)
}

/** true se a data `AAAA-MM-DD` cai de segunda a sexta. */
export function ehDiaUtil(data) {
  const diaDaSemana = new Date(emUtc(data)).getUTCDay()
  return diaDaSemana >= 1 && diaDaSemana <= 5
}

/**
 * Dias úteis entre dois instantes, pelas datas locais: conta as datas `d` com
 * `inicio < d <= fim` (início exclusivo, fim inclusivo) de segunda a sexta. Mesmo dia ou
 * fim antes do início → 0.
 */
export function diasUteisEntre(inicio, fim) {
  const ultimo = emUtc(dataLocal(fim))
  let dias = 0
  for (let ms = emUtc(dataLocal(inicio)) + DIA_MS; ms <= ultimo; ms += DIA_MS) {
    if (ehDiaUtil(deUtc(ms))) dias++
  }
  return dias
}
