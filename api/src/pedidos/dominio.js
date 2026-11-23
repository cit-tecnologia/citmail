// Regras de domínio do pedido (ADR 0014, D6; CIT-61): as mesmas de `assets/checkout.js`.
// Mudança aqui exige a mesma mudança lá (teste de paridade de domínio).

// Normaliza o que o cliente digitou: minúsculas, sem "www." inicial e sem ponto final (e, no novo domínio, sem ".com.br").
export function normalizarDominioNovo(v) {
  return v.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '').replace(/\.com\.br$/, '');
}
export function normalizarDominioExistente(v) {
  return v.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}
// .com.br: 2 a 26 caracteres a-z/0-9/hífen, sem hífen nas pontas, não só números, sem "--" nas posições 3-4 (posições contadas a partir de 1; no código, slice(2, 4) = índices 2-3).
export function dominioNovoValido(n) {
  return /^[a-z0-9][a-z0-9-]{0,24}[a-z0-9]$/.test(n) && !/^[0-9]+$/.test(n) && n.slice(2, 4) !== '--';
}
export function dominioExistenteValido(d) {
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);
}

// Nome gravado: o domínio novo vira `<rótulo>.com.br`; null se inválido.
export function nomeDominioNovo(valor) {
  const rotulo = normalizarDominioNovo(valor)
  return dominioNovoValido(rotulo) ? `${rotulo}.com.br` : null
}

export function nomeDominioExistente(valor) {
  const nome = normalizarDominioExistente(valor)
  return dominioExistenteValido(nome) ? nome : null
}
