// Escape dos modelos de e-mail (ADR 0010; CIT-65), sem engine de template.
// `html` é um tagged template que escapa `& < > " '` em todo valor interpolado; só entra
// cru o que veio de outro `html` (marca interna `HtmlSeguro`), o que permite compor
// trechos. Arrays são concatenados, cada item com a mesma regra; `null` e `undefined`
// viram texto vazio. `texto` faz o mesmo para a parte texto puro: cada valor passa por
// `limparLinha`, e só as quebras de linha do próprio modelo ficam.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

class HtmlSeguro {
  #texto

  constructor(texto) {
    this.#texto = texto
  }

  toString() {
    return this.#texto
  }
}

// true só para o resultado do tagged template `html` (o handler recusa outro tipo).
export function ehHtmlSeguro(valor) {
  return valor instanceof HtmlSeguro
}

export function escaparHtml(valor) {
  return String(valor).replace(/[&<>"']/g, (caractere) => ESCAPES[caractere])
}

// Remove CR, LF e os demais caracteres de controle (C0, DEL, C1) e os separadores de
// linha e parágrafo do Unicode: nenhum valor quebra a linha de um cabeçalho (assunto) ou
// do texto. Acentos e demais caracteres ficam.
export function limparLinha(valor) {
  if (valor === null || valor === undefined) return ''
  // eslint-disable-next-line no-control-regex -- remover caractere de controle é o objetivo
  return String(valor).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
}

function interpolarHtml(valor) {
  if (valor === null || valor === undefined) return ''
  if (valor instanceof HtmlSeguro) return valor.toString()
  if (Array.isArray(valor)) return valor.map(interpolarHtml).join('')
  return escaparHtml(valor)
}

function interpolarTexto(valor) {
  if (Array.isArray(valor)) return valor.map(interpolarTexto).join('')
  return limparLinha(valor)
}

export function html(partes, ...valores) {
  let saida = partes[0]
  for (let i = 0; i < valores.length; i++) {
    saida += interpolarHtml(valores[i]) + partes[i + 1]
  }
  return new HtmlSeguro(saida)
}

export function texto(partes, ...valores) {
  let saida = partes[0]
  for (let i = 0; i < valores.length; i++) {
    saida += interpolarTexto(valores[i]) + partes[i + 1]
  }
  return saida
}
