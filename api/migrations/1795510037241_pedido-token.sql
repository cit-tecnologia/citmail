-- Up Migration
-- Token de acompanhamento do pedido (ADR 0016; CIT-69). O banco guarda só o SHA-256 em
-- hex do token (`token_hash`); o token em claro só existe no 201 de `POST /api/pedidos`.
-- Nulável: pedidos anteriores ficam sem token (sem backfill); sem expiração no MVP.
ALTER TABLE pedido ADD COLUMN token_hash char(64) UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$');

-- O papel `<banco>_aplicacao` já existe (migração da auditoria, CIT-58): grava o hash na
-- conclusão do pedido e na rotação pelo reenvio da mesma chave.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('GRANT UPDATE (token_hash) ON pedido TO %I', papel);
END
$$;

-- Down Migration
-- Sem guarda: o hash não tem valor fora do link do comprador; o down só invalida os links.
-- O DROP COLUMN leva junto o UNIQUE, o CHECK e o GRANT da coluna.
ALTER TABLE pedido DROP COLUMN token_hash;
