// Máscara do destinatário gravada em `email_envio` (ADR 0010; CIT-65): 1ª letra da parte
// local, `***`, `@` e o domínio (`a***@exemplo.com.br`). Entrada que não é um endereço
// (sem `@`, parte local ou domínio vazios) vira só `***`.
export function mascararEmail(email) {
  if (typeof email !== 'string') return '***'
  const arroba = email.lastIndexOf('@')
  if (arroba <= 0 || arroba === email.length - 1) return '***'
  return `${email[0]}***@${email.slice(arroba + 1)}`
}
