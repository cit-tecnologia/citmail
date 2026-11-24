// Aceite dos termos no pedido (CIT-62). O cliente envia as versões que viu; o servidor
// só aceita as vigentes (409 `versao_termos_divergente`). A paridade de `VERSAO_TERMOS`
// e `TERMOS_MINUTA` com `termos.html` é conferida por teste.
import { isIP } from 'node:net'

export const VERSAO_TERMOS = '0.1'
// Termos em minuta: com pedidos ligados em produção, a API não sobe (config.js).
export const TERMOS_MINUTA = true
// Provisória: a Política de Privacidade é externa e sem versão; o rótulo definitivo é
// pendência do responsável/DPO.
export const VERSAO_PRIVACIDADE = 'externa-2026-11-23'
// Rótulo da Política ainda provisório: trava a produção como a minuta (config.js). Na 1.0,
// trocar junto `TERMOS_MINUTA`, `PRIVACIDADE_PROVISORIA`, `VERSAO_PRIVACIDADE` e a página.
export const PRIVACIDADE_PROVISORIA = true

// IP do aceite a partir de `request.ip` (trustProxy do app.js, ADR 0013 item 3): sem o
// sufixo de zona (`%eth0`) e com `::ffff:a.b.c.d` como IPv4 (pseudonimização /24
// futura). null se o resultado não for um IP.
export function normalizarIp(ip) {
  if (typeof ip !== 'string') return null
  let valor = ip.trim().replace(/%.*$/, '')
  const mapeado = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(valor)
  if (mapeado) valor = mapeado[1]
  return isIP(valor) !== 0 ? valor : null
}
