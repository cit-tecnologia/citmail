-- Up Migration
-- Outbox de eventos de domínio (ADR 0005, opção 2; CIT-166): `evento` é gravada na
-- transação da mudança de estado e publicada na fila pelo worker; `evento_processado`
-- marca, por consumidor, o evento já tratado (consumidor idempotente).
-- O papel `<banco>_aplicacao` já existe: nasce na migração da auditoria (CIT-58).

-- O vocabulário de `nome` fica em `src/eventos/vocabulario.js` (o CHECK só barra o
-- formato: nome novo não exige migração). `agregado_tipo` é o do anexo de eventos.
CREATE TABLE evento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL CHECK (nome ~ '^[a-z][a-z_]{0,63}$'),
  versao integer NOT NULL DEFAULT 1 CHECK (versao >= 1),
  agregado_tipo text NOT NULL CHECK (agregado_tipo IN ('pedido', 'conta_titular', 'assinatura')),
  agregado_id text NOT NULL CHECK (char_length(agregado_id) BETWEEN 1 AND 64),
  chave_idempotencia text NOT NULL UNIQUE CHECK (char_length(chave_idempotencia) BETWEEN 1 AND 200),
  -- Só ids e dados não pessoais (recusados no serviço); o limite aqui é proteção extra.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
  request_id text CHECK (char_length(request_id) <= 128),
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  publicado_em timestamptz,
  tentativas_publicacao integer NOT NULL DEFAULT 0 CHECK (tentativas_publicacao >= 0)
);

-- Varredura do publicador: só os pendentes, na ordem de ocorrência.
CREATE INDEX evento_pendente_idx ON evento (ocorrido_em, id) WHERE publicado_em IS NULL;

-- Sem hífen no consumidor: é o separador do `jobId` (`<consumidor>-<eventoId>`).
-- ON DELETE CASCADE prepara a limpeza conjunta (retenção em história própria).
CREATE TABLE evento_processado (
  consumidor text NOT NULL CHECK (consumidor ~ '^[a-z][a-z0-9_]{0,47}$'),
  evento_id uuid NOT NULL REFERENCES evento (id) ON DELETE CASCADE,
  processado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumidor, evento_id)
);

-- O REVOKE explícito ao papel anula um ALTER DEFAULT PRIVILEGES futuro. A aplicação
-- não escolhe `id`, `ocorrido_em` nem `processado_em` (42501) e só altera as duas
-- colunas do publicador; nada de DELETE.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE ALL ON evento, evento_processado FROM PUBLIC, %I', papel);
  EXECUTE format('GRANT SELECT ON evento TO %I', papel);
  EXECUTE format(
    'GRANT INSERT (nome, versao, agregado_tipo, agregado_id, chave_idempotencia, payload, request_id) '
    'ON evento TO %I',
    papel
  );
  EXECUTE format('GRANT UPDATE (publicado_em, tentativas_publicacao) ON evento TO %I', papel);
  EXECUTE format('GRANT SELECT ON evento_processado TO %I', papel);
  EXECUTE format('GRANT INSERT (consumidor, evento_id) ON evento_processado TO %I', papel);
END
$$;

-- Down Migration
-- Guarda: com eventos, o down é recusado (perderia eventos não publicados e as marcas
-- dos consumidores). O LOCK impede um INSERT entre a conferência e o DROP.
LOCK TABLE evento, evento_processado IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM evento) THEN
    RAISE EXCEPTION 'evento com registros: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

DROP TABLE evento_processado;
DROP TABLE evento;
