-- Up Migration
-- Pedido do checkout e a criação no Asaas (ADR 0014; CIT-61): `cliente` (quem compra,
-- espelho do cliente do Asaas), `pedido`, `pedido_dominio` (cada domínio é um item com
-- id próprio, o `dominioItemId` dos eventos da E4) e `assinatura` (contas e domínios).
-- O papel `<banco>_aplicacao` já existe: nasce na migração da auditoria (CIT-58).
-- Nenhuma coluna guarda cartão: a forma de pagamento é escolhida na fatura do Asaas.

-- O cliente reaproveitado não muda (ADR 0014): o contato de cada compra fica no pedido.
CREATE TABLE cliente (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_pessoa text NOT NULL CHECK (tipo_pessoa IN ('fisica', 'juridica')),
  -- Normalizado no serviço (sem máscara, maiúsculas); CNPJ alfanumérico aceito.
  documento text NOT NULL UNIQUE CHECK (documento ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 2 AND 100),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  telefone text NOT NULL CHECK (telefone ~ '^[0-9]{10,11}$'),
  asaas_cliente_id text UNIQUE CHECK (asaas_cliente_id ~ '^[A-Za-z0-9_]{1,64}$'),
  anonimizado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo_pessoa = 'fisica') = (char_length(documento) = 11))
);

-- `criando` é o estado gravado antes de qualquer chamada ao Asaas; os demais são os do
-- anexo de modelo de dados. `criando_desde` é a posse do fluxo (retomada pelo prazo).
-- `falha_motivo` é código (sem dado pessoal), aceito nos dois estados de falha.
-- `contato_*` é o contato informado nesta compra (dado pessoal, anonimização da E6-H3).
CREATE TABLE pedido (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES cliente (id),
  chave_idempotencia uuid NOT NULL UNIQUE,
  corpo_hash char(64) NOT NULL CHECK (corpo_hash ~ '^[0-9a-f]{64}$'),
  estado text NOT NULL CHECK (estado IN (
    'criando', 'aguardando_pagamento', 'falhou_na_criacao', 'aguardando_pagamento_do_dominio',
    'aguardando_registro_de_dominio', 'pago', 'ativo', 'falha_no_provisionamento', 'cancelado'
  )),
  criando_desde timestamptz,
  ciclo text NOT NULL CHECK (ciclo IN ('mensal', 'anual')),
  itens jsonb NOT NULL CHECK (jsonb_typeof(itens) = 'object' AND octet_length(itens::text) <= 16384),
  total_centavos integer NOT NULL CHECK (total_centavos > 0),
  versao_tabela_precos text NOT NULL CHECK (char_length(versao_tabela_precos) BETWEEN 1 AND 32),
  contato_nome text NOT NULL CHECK (char_length(contato_nome) BETWEEN 2 AND 100),
  contato_email text NOT NULL CHECK (char_length(contato_email) BETWEEN 3 AND 254),
  contato_telefone text NOT NULL CHECK (contato_telefone ~ '^[0-9]{10,11}$'),
  falha_motivo text CHECK (falha_motivo ~ '^[a-z][a-z0-9_]{0,47}$'),
  request_id text CHECK (char_length(request_id) <= 128),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((estado = 'criando') = (criando_desde IS NOT NULL)),
  CHECK (falha_motivo IS NULL OR estado IN ('falhou_na_criacao', 'falha_no_provisionamento')),
  CHECK (estado <> 'falhou_na_criacao' OR falha_motivo IS NOT NULL)
);

CREATE INDEX pedido_cliente_idx ON pedido (cliente_id);

-- Nome gravado normalizado (domínio novo já com `.com.br`).
CREATE TABLE pedido_dominio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL REFERENCES pedido (id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 4 AND 253),
  tipo text NOT NULL CHECK (tipo IN ('novo', 'existente')),
  papel text NOT NULL CHECK (papel IN ('principal', 'extra')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pedido_id, nome),
  CHECK (papel = 'principal' OR tipo = 'novo')
);

CREATE UNIQUE INDEX pedido_dominio_principal_unico ON pedido_dominio (pedido_id) WHERE papel = 'principal';

-- Uma assinatura por tipo e pedido; a de domínios é sempre anual.
CREATE TABLE assinatura (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL REFERENCES pedido (id),
  cliente_id uuid NOT NULL REFERENCES cliente (id),
  tipo text NOT NULL CHECK (tipo IN ('contas', 'dominios')),
  ciclo text NOT NULL CHECK (ciclo IN ('mensal', 'anual')),
  valor_centavos integer NOT NULL CHECK (valor_centavos > 0),
  estado text NOT NULL DEFAULT 'ativa' CHECK (estado IN ('ativa', 'cancelamento_solicitado', 'cancelada')),
  asaas_assinatura_id text NOT NULL UNIQUE CHECK (asaas_assinatura_id ~ '^[A-Za-z0-9_]{1,64}$'),
  url_primeira_fatura text CHECK (url_primeira_fatura ~ '^https://' AND char_length(url_primeira_fatura) <= 2048),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pedido_id, tipo),
  CHECK (tipo <> 'dominios' OR ciclo = 'anual')
);

CREATE INDEX assinatura_cliente_idx ON assinatura (cliente_id);

CREATE TRIGGER cliente_definir_atualizado_em BEFORE UPDATE ON cliente
  FOR EACH ROW EXECUTE FUNCTION definir_atualizado_em();
CREATE TRIGGER pedido_definir_atualizado_em BEFORE UPDATE ON pedido
  FOR EACH ROW EXECUTE FUNCTION definir_atualizado_em();
CREATE TRIGGER pedido_dominio_definir_atualizado_em BEFORE UPDATE ON pedido_dominio
  FOR EACH ROW EXECUTE FUNCTION definir_atualizado_em();
CREATE TRIGGER assinatura_definir_atualizado_em BEFORE UPDATE ON assinatura
  FOR EACH ROW EXECUTE FUNCTION definir_atualizado_em();

-- O REVOKE explícito ao papel anula um ALTER DEFAULT PRIVILEGES futuro. INSERT só nas
-- colunas que o serviço grava; UPDATE só nas 4 colunas do fluxo de criação (o cliente
-- reaproveitado não muda); nada de DELETE.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE ALL ON cliente, pedido, pedido_dominio, assinatura FROM PUBLIC, %I', papel);
  EXECUTE format('GRANT SELECT ON cliente, pedido, pedido_dominio, assinatura TO %I', papel);
  EXECUTE format(
    'GRANT INSERT (tipo_pessoa, documento, nome, email, telefone) ON cliente TO %I',
    papel
  );
  EXECUTE format('GRANT UPDATE (asaas_cliente_id) ON cliente TO %I', papel);
  EXECUTE format(
    'GRANT INSERT (cliente_id, chave_idempotencia, corpo_hash, estado, criando_desde, ciclo, itens, '
    'total_centavos, versao_tabela_precos, contato_nome, contato_email, contato_telefone, request_id) '
    'ON pedido TO %I',
    papel
  );
  EXECUTE format('GRANT UPDATE (estado, falha_motivo, criando_desde) ON pedido TO %I', papel);
  EXECUTE format('GRANT INSERT (pedido_id, nome, tipo, papel) ON pedido_dominio TO %I', papel);
  EXECUTE format(
    'GRANT INSERT (pedido_id, cliente_id, tipo, ciclo, valor_centavos, asaas_assinatura_id, url_primeira_fatura) '
    'ON assinatura TO %I',
    papel
  );
END
$$;

-- Down Migration
-- Guarda: com registros, o down é recusado (perderia pedidos e o vínculo com o Asaas).
-- O LOCK impede um INSERT entre a conferência e o DROP.
LOCK TABLE cliente, pedido, pedido_dominio, assinatura IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cliente) OR EXISTS (SELECT 1 FROM pedido)
     OR EXISTS (SELECT 1 FROM pedido_dominio) OR EXISTS (SELECT 1 FROM assinatura) THEN
    RAISE EXCEPTION 'pedidos com registros: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

DROP TABLE assinatura;
DROP TABLE pedido_dominio;
DROP TABLE pedido;
DROP TABLE cliente;
