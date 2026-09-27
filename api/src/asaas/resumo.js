// O que do webhook do Asaas pode ir para o log (ADR 0013, item 8; CIT-55): só
// estes quatro campos. Nunca logar `request.body`, o `payment`/`customer`
// inteiro nem o header `asaas-access-token`.

function texto(valor) {
  return typeof valor === 'string' ? valor : undefined
}

export function resumoEventoAsaas(evento) {
  const pagamento = evento?.payment
  return {
    event: texto(evento?.event),
    paymentId: texto(pagamento?.id),
    paymentStatus: texto(pagamento?.status),
    billingType: texto(pagamento?.billingType)
  }
}
