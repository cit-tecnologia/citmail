-- Up Migration
-- Aceite dos termos no pedido (CIT-62): data e hora (relógio do banco, o mesmo instante
-- de `criado_em`), versões dos termos e da política vistas pelo cliente e IP do aceite
-- (dado pessoal; retenção como a da auditoria, ADR 0013 item 9). Gravadas só no INSERT
-- do estado `criando`: nenhum UPDATE nelas.
-- NOT NULL direto: a guarda recusa aplicar se já houver pedido (sem aceite para
-- preencher). Desenvolvimento e homologação limpam os pedidos de teste à mão antes
-- (api/README.md); a migração não apaga nada.
LOCK TABLE pedido IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pedido) THEN
    RAISE EXCEPTION 'pedido sem aceite: limpe os pedidos de teste antes de aplicar (CIT-62)' USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE pedido
  ADD COLUMN aceite_em timestamptz NOT NULL,
  ADD COLUMN versao_termos text NOT NULL CHECK (versao_termos ~ '^[0-9A-Za-z._-]{1,32}$'),
  ADD COLUMN versao_privacidade text NOT NULL CHECK (versao_privacidade ~ '^[0-9A-Za-z._-]{1,64}$'),
  ADD COLUMN ip_aceite inet NOT NULL;

-- Só INSERT nas 4 colunas (a futura pseudonimização do IP ganha UPDATE por papel próprio).
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format(
    'GRANT INSERT (aceite_em, versao_termos, versao_privacidade, ip_aceite) ON pedido TO %I',
    papel
  );
END
$$;

-- Down Migration
-- Guarda: com pedidos, o down é recusado (todo pedido tem aceite, prova do consentimento).
-- O LOCK impede um INSERT entre a conferência e o DROP.
LOCK TABLE pedido IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pedido) THEN
    RAISE EXCEPTION 'pedidos com aceite: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE pedido
  DROP COLUMN ip_aceite,
  DROP COLUMN versao_privacidade,
  DROP COLUMN versao_termos,
  DROP COLUMN aceite_em;
