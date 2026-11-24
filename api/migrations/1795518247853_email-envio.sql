-- Up Migration
-- Registro do e-mail transacional (ADR 0010; CIT-65). Uma linha por envio pedido pelo
-- consumidor de um evento (`solicitarEmail`), enviada por um job `email_enviar` criado
-- pelo enfileirador do worker. Sem endereço em claro nem corpo: o destinatário e as
-- variáveis são lidos do banco no envio; aqui ficam só a máscara, o modelo e o estado.
-- O papel `<banco>_aplicacao` já existe: nasce na migração da auditoria (CIT-58).
CREATE TABLE email_envio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id uuid REFERENCES evento (id) ON DELETE SET NULL,
  -- Ex.: `<modelo>-<eventoId>` ou `<modelo>-<eventoId>-<contaId>` (vários destinatários por evento).
  chave_idempotencia text NOT NULL UNIQUE CHECK (char_length(chave_idempotencia) BETWEEN 1 AND 200),
  modelo text NOT NULL CHECK (modelo ~ '^[a-z][a-z0-9_]{0,47}$'),
  versao_modelo integer NOT NULL CHECK (versao_modelo >= 1),
  -- Só ids (recusados no serviço se não forem); o limite aqui é proteção extra.
  refs jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(refs) = 'object' AND octet_length(refs::text) <= 1024),
  destinatario_mascarado text CHECK (char_length(destinatario_mascarado) <= 260),
  estado text NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'enviado', 'falhou', 'nao_enviado')),
  -- Reenvio (decisão 10): cada reset soma 1 e o enfileirador cria o job `email_enviar-<id>-<geracao>`.
  geracao integer NOT NULL DEFAULT 1 CHECK (geracao >= 1),
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  -- Só código SMTP ou do `nodemailer`, `SEM_DESTINATARIO` ou `ERRO_DESCONHECIDO` (erro sem
  -- código): nunca a mensagem do servidor.
  erro_codigo text CHECK (erro_codigo ~ '^[A-Z0-9_]{1,32}$'),
  message_id text CHECK (char_length(message_id) <= 255),
  criado_em timestamptz NOT NULL DEFAULT now(),
  enfileirado_em timestamptz,
  enviado_em timestamptz,
  alertado_parado_em timestamptz
);

-- Enfileirador e varredura de parados: só os pendentes.
CREATE INDEX email_envio_pendente_idx ON email_envio (enfileirado_em) WHERE estado = 'pendente';
-- Retenção de 90 dias (limpeza em história própria).
CREATE INDEX email_envio_criado_idx ON email_envio (criado_em);

-- O REVOKE explícito ao papel anula um ALTER DEFAULT PRIVILEGES futuro. A aplicação só
-- insere as colunas de `solicitarEmail` (estado, tentativas e datas nascem no padrão e
-- mudam por UPDATE), não altera `modelo`, `refs`, `chave_idempotencia` nem `evento_id`,
-- e não apaga.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE ALL ON email_envio FROM PUBLIC, %I', papel);
  EXECUTE format('GRANT SELECT ON email_envio TO %I', papel);
  EXECUTE format(
    'GRANT INSERT (evento_id, chave_idempotencia, modelo, versao_modelo, refs) ON email_envio TO %I',
    papel
  );
  EXECUTE format(
    'GRANT UPDATE (estado, geracao, tentativas, erro_codigo, message_id, enfileirado_em, enviado_em, '
    'destinatario_mascarado, alertado_parado_em) ON email_envio TO %I',
    papel
  );
END
$$;

-- Down Migration
-- Guarda: com registros, o down é recusado (perderia o histórico e os pendentes). O LOCK
-- impede um INSERT entre a conferência e o DROP.
LOCK TABLE email_envio IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM email_envio) THEN
    RAISE EXCEPTION 'email_envio com registros: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

DROP TABLE email_envio;
