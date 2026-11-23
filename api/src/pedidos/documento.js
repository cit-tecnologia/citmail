// CPF e CNPJ do pedido (ADR 0014, D6; CIT-61). O documento é normalizado antes de
// validar e de comparar: sem espaços, `.`, `-` e `/`, em maiúsculas.

export function normalizarDocumento(valor) {
  return String(valor).replace(/[\s./-]/g, '').toUpperCase()
}

function todosIguais(documento) {
  return /^(.)\1*$/.test(documento)
}

function cpfValido(cpf) {
  if (!/^[0-9]{11}$/.test(cpf) || todosIguais(cpf)) return false
  const digitos = [...cpf].map(Number)
  for (const tamanho of [9, 10]) {
    let soma = 0
    for (let i = 0; i < tamanho; i++) soma += digitos[i] * (tamanho + 1 - i)
    const resto = (soma * 10) % 11
    if ((resto === 10 ? 0 : resto) !== digitos[tamanho]) return false
  }
  return true
}

// CNPJ numérico ou alfanumérico (Receita, a partir de 07/2026): 12 posições [0-9A-Z]
// e 2 dígitos verificadores, por módulo 11 sobre `código ASCII − 48`.
function cnpjValido(cnpj) {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj) || todosIguais(cnpj)) return false
  const valores = [...cnpj].map((caractere) => caractere.charCodeAt(0) - 48)
  for (const tamanho of [12, 13]) {
    let soma = 0
    for (let i = 0; i < tamanho; i++) {
      const peso = ((tamanho - 1 - i) % 8) + 2
      soma += valores[i] * peso
    }
    const resto = soma % 11
    if ((resto < 2 ? 0 : 11 - resto) !== valores[tamanho]) return false
  }
  return true
}

// 'fisica', 'juridica' ou null (documento inválido). Recebe o documento normalizado.
export function tipoPessoa(documento) {
  if (cpfValido(documento)) return 'fisica'
  if (cnpjValido(documento)) return 'juridica'
  return null
}
