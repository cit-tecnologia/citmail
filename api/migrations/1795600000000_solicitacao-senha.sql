-- Up Migration
-- Definição e redefinição da senha do titular por link (E5-H2; CIT-71; ADR 0008):
-- `solicitacao_senha` (uma linha por pedido de link; só o SHA-256 do token, gravado no envio
-- pela #72 com `emitirToken`) e o UPDATE da senha e do estado em `conta_titular`.
-- O papel `<banco>_aplicacao` já existe: nasce na migração da auditoria (CIT-58).

-- `token_hash` nulo até o envio; trocado a cada reenvio (o link anterior deixa de valer).
-- `usada_em`: consumida pela definição ou invalidada por outra da mesma conta.
CREATE TABLE solicitacao_senha (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_titular_id uuid NOT NULL REFERENCES conta_titular (id),
  tipo text NOT NULL CHECK (tipo IN ('primeiro_acesso', 'redefinicao')),
  token_hash text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  criada_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  enviada_em timestamptz,
  usada_em timestamptz,
  CHECK (expira_em > criada_em)
);

-- Limites por conta (janela de 5 min e abertas) e invalidação das outras abertas.
CREATE INDEX solicitacao_senha_conta_idx ON solicitacao_senha (conta_titular_id, criada_em DESC);

-- O REVOKE explícito ao papel anula um ALTER DEFAULT PRIVILEGES futuro. A aplicação insere
-- só a conta, o tipo e o prazo (nunca `id` nem `criada_em`), altera só o hash e as datas de
-- envio e uso e não apaga (retenção em história própria). Em `conta_titular`, UPDATE só na
-- senha e no estado (também habilita o `SELECT ... FOR UPDATE`); nunca no e-mail.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE ALL ON solicitacao_senha FROM PUBLIC, %I', papel);
  EXECUTE format('GRANT SELECT ON solicitacao_senha TO %I', papel);
  EXECUTE format('GRANT INSERT (conta_titular_id, tipo, expira_em) ON solicitacao_senha TO %I', papel);
  EXECUTE format('GRANT UPDATE (token_hash, enviada_em, usada_em) ON solicitacao_senha TO %I', papel);
  EXECUTE format('GRANT UPDATE (senha_hash, senha_definida_em, estado) ON conta_titular TO %I', papel);
END
$$;

-- Down Migration
-- Guarda: com solicitações, o down é recusado (perderia o histórico dos links). O LOCK
-- impede um INSERT entre a conferência e o DROP.
LOCK TABLE solicitacao_senha, conta_titular IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM solicitacao_senha) THEN
    RAISE EXCEPTION 'solicitações de senha com registros: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE UPDATE (senha_hash, senha_definida_em, estado) ON conta_titular FROM %I', papel);
END
$$;

DROP TABLE solicitacao_senha;
