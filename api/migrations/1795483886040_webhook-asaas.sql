-- Up Migration
-- Webhook do Asaas (ADR 0015; CIT-64): `asaas_webhook_evento` (evento bruto, só os campos
-- da lista branca), `conta_titular` (nasce com o 1º pagamento das contas, sem senha) e
-- `pedido.dominio_pago_em` (1º pagamento da assinatura de domínios).
-- O papel `<banco>_aplicacao` já existe: nasce na migração da auditoria (CIT-58).

-- Nunca gravados: `customer`, `description`, `observations`, `invoiceUrl`, `bankSlipUrl`,
-- `creditCard*`, nome, e-mail, documento, endereço, nem o corpo inteiro (ADR 0005, item 6).
-- `situacao` começa `pendente`; o resultado terminal (`processado`, `ignorado` ou
-- `divergente`) grava `processado_em` junto. `codigo` é código, sem texto livre.
CREATE TABLE asaas_webhook_evento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asaas_evento_id text NOT NULL UNIQUE CHECK (char_length(asaas_evento_id) BETWEEN 1 AND 128),
  evento text NOT NULL CHECK (char_length(evento) BETWEEN 1 AND 64),
  request_id text CHECK (char_length(request_id) <= 128),
  pagamento_id text CHECK (pagamento_id ~ '^[A-Za-z0-9_]{1,64}$'),
  assinatura_id text CHECK (assinatura_id ~ '^[A-Za-z0-9_]{1,64}$'),
  referencia_externa text CHECK (char_length(referencia_externa) <= 100),
  status text CHECK (status ~ '^[A-Z_]{1,64}$'),
  billing_type text CHECK (billing_type ~ '^[A-Z_]{1,64}$'),
  valor_centavos integer CHECK (valor_centavos >= 0),
  vencimento date,
  pago_em date,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  enfileirado_em timestamptz,
  processado_em timestamptz,
  alertado_pendente_em timestamptz,
  situacao text NOT NULL DEFAULT 'pendente' CHECK (situacao IN ('pendente', 'processado', 'ignorado', 'divergente')),
  codigo text CHECK (codigo ~ '^[a-z][a-z0-9_]{0,47}$'),
  CHECK ((situacao = 'pendente') = (processado_em IS NULL))
);

-- Enfileirador: só os ainda não enfileirados, na ordem de chegada.
CREATE INDEX asaas_webhook_evento_nao_enfileirado_idx ON asaas_webhook_evento (recebido_em, id)
  WHERE enfileirado_em IS NULL;
-- Alerta de bruto parado (`webhook_parado`).
CREATE INDEX asaas_webhook_evento_pendente_idx ON asaas_webhook_evento (enfileirado_em)
  WHERE situacao = 'pendente';
-- Pagamento repetido (`pagamentoJaAplicado`): procura por pagamento entre os processados.
CREATE INDEX asaas_webhook_evento_pagamento_processado_idx ON asaas_webhook_evento (pagamento_id)
  WHERE situacao = 'processado';
-- Retenção de 90 dias (limpeza em história própria).
CREATE INDEX asaas_webhook_evento_recebido_idx ON asaas_webhook_evento (recebido_em);

-- Conta do titular (anexo de modelo de dados): uma por cliente, e-mail único e em
-- minúsculas (login). Nasce `sem_senha`; a senha é da E5-H2.
CREATE TABLE conta_titular (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL UNIQUE REFERENCES cliente (id),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  senha_hash text,
  senha_definida_em timestamptz,
  estado text NOT NULL DEFAULT 'sem_senha' CHECK (estado IN ('sem_senha', 'ativa', 'suspensa', 'cancelada')),
  suspensa_em timestamptz,
  motivo_suspensao text CHECK (motivo_suspensao IN ('inadimplencia')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER conta_titular_definir_atualizado_em BEFORE UPDATE ON conta_titular
  FOR EACH ROW EXECUTE FUNCTION definir_atualizado_em();

-- Nulável, sem guarda: pedido sem domínio novo nunca a preenche.
ALTER TABLE pedido ADD COLUMN dominio_pago_em timestamptz;

-- O REVOKE explícito ao papel anula um ALTER DEFAULT PRIVILEGES futuro. INSERT do bruto
-- só nas colunas da lista branca e em `request_id`; UPDATE só nas do processamento;
-- `conta_titular` sem UPDATE nesta história; nada de DELETE (a limpeza de 90 dias
-- ganha papel próprio).
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE ALL ON asaas_webhook_evento, conta_titular FROM PUBLIC, %I', papel);
  EXECUTE format('GRANT SELECT ON asaas_webhook_evento, conta_titular TO %I', papel);
  EXECUTE format(
    'GRANT INSERT (asaas_evento_id, evento, request_id, pagamento_id, assinatura_id, referencia_externa, '
    'status, billing_type, valor_centavos, vencimento, pago_em) ON asaas_webhook_evento TO %I',
    papel
  );
  EXECUTE format(
    'GRANT UPDATE (enfileirado_em, processado_em, situacao, codigo, alertado_pendente_em) '
    'ON asaas_webhook_evento TO %I',
    papel
  );
  EXECUTE format('GRANT INSERT (cliente_id, email, estado) ON conta_titular TO %I', papel);
  EXECUTE format('GRANT UPDATE (dominio_pago_em) ON pedido TO %I', papel);
END
$$;

-- Down Migration
-- Guarda: com registros, o down é recusado (perderia eventos do Asaas guardados para
-- reenvio e contas de titulares). O LOCK impede um INSERT entre a conferência e o DROP.
LOCK TABLE asaas_webhook_evento, conta_titular, pedido IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM asaas_webhook_evento) OR EXISTS (SELECT 1 FROM conta_titular) THEN
    RAISE EXCEPTION 'webhook do asaas com registros: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE pedido DROP COLUMN dominio_pago_em;
DROP TABLE conta_titular;
DROP TABLE asaas_webhook_evento;
