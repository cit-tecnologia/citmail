// Vocabulário fechado dos eventos de domínio (ADR 0005; anexo `eventos-de-dominio.md`;
// CIT-166). O CHECK de `evento.nome` só confere o formato: nome novo entra aqui e no
// anexo, sem migração. `cobranca_paga` e `assinatura_cancelada` são nomes propostos,
// a confirmar antes do emissor (E3-H4, E3-H7). `dominio_registrado` (CIT-77): todos os
// domínios novos do pedido registrados pela equipe, sem consumidor até a #68.
export const NOMES_EVENTOS = Object.freeze([
  'pedido_pago', 'dominio_pago', 'dominio_registrado', 'conta_titular_criada', 'cobranca_vencida', 'cobranca_paga',
  'definicao_senha_solicitada', 'conta_ativada', 'dominio_verificado', 'conta_suspensa', 'conta_reativada',
  'cancelamento_solicitado', 'assinatura_cancelada'
])
