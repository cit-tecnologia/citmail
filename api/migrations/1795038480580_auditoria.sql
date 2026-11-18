-- Up Migration
-- Trilha de auditoria das ações críticas (ADR 0013, itens 7 e 9; CIT-58): tabela
-- só de inclusão. O papel da aplicação é por banco (`<banco>_aplicacao`), para
-- homologação e produção no mesmo cluster não compartilharem permissões.

-- Papel da aplicação. Se o admin já o criou (#57), nada é criado e o migrador
-- não precisa de CREATEROLE. Nome acima de 63 bytes seria truncado em silêncio.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  IF octet_length(current_database()) > 53 THEN
    RAISE EXCEPTION 'nome do banco longo demais para o papel %', papel;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', papel);
    EXCEPTION
      -- Dois up concorrentes em bancos diferentes dão 23505, não 42710.
      WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;
END
$$;

-- O alvo não tem chave estrangeira: o registro sobrevive à anonimização (E6-H3).
-- O vocabulário dos CHECK é o mesmo de `src/auditoria/vocabulario.js`.
CREATE TABLE auditoria (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- clock_timestamp(): instante do registro, não o início da transação do chamador.
  ocorrido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  autor_tipo text NOT NULL CHECK (autor_tipo IN ('cliente', 'sistema', 'equipe')),
  autor_id text CHECK (char_length(autor_id) <= 64),
  acao text NOT NULL CHECK (acao IN (
    'login', 'login_falhou', 'conta_bloqueada', 'caixa_criada', 'caixa_excluida', 'senha_trocada',
    'cadastro_alterado', 'assinatura_cancelada', 'dados_excluidos', 'conta_suspensa', 'conta_reativada',
    'dominio_registrado_manualmente'
  )),
  alvo_tipo text NOT NULL CHECK (alvo_tipo IN ('conta', 'caixa', 'cliente', 'pedido', 'assinatura', 'dominio')),
  alvo_id text CHECK (char_length(alvo_id) <= 64),
  ip inet CHECK (ip IS NOT NULL OR autor_tipo = 'sistema'),
  resultado text NOT NULL CHECK (resultado IN ('sucesso', 'falha')),
  request_id text CHECK (char_length(request_id) <= 128),
  -- Sem senha nem token (recusados no serviço); o limite aqui é proteção extra.
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detalhes) = 'object' AND octet_length(detalhes::text) <= 4096),
  -- autor_id nulo só para o sistema ou falha de login; alvo_id nulo só na falha de login (D4).
  CHECK (autor_id IS NOT NULL OR autor_tipo = 'sistema' OR acao = 'login_falhou'),
  CHECK (alvo_id IS NOT NULL OR acao = 'login_falhou')
);

CREATE INDEX auditoria_alvo_idx ON auditoria (alvo_tipo, alvo_id, ocorrido_em);

-- Só inclusão, até para o dono. Única exceção: o papel `<banco>_retencao` pode
-- alterar só a coluna ip (pseudonimização aos 6 meses; papel e rotina em outra
-- história). SET de variável de sessão não serviria de chave: qualquer papel faz.
CREATE FUNCTION auditoria_bloquear_alteracao() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_user = current_database() || '_retencao'
     AND (to_jsonb(NEW) - 'ip') = (to_jsonb(OLD) - 'ip') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'auditoria só de inclusão: % bloqueado', TG_OP USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER auditoria_bloquear_alteracao_linha
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_bloquear_alteracao();

CREATE TRIGGER auditoria_bloquear_truncate
  BEFORE TRUNCATE ON auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION auditoria_bloquear_alteracao();

-- O REVOKE explícito ao papel anula um ALTER DEFAULT PRIVILEGES futuro.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE ALL ON auditoria FROM PUBLIC, %I', papel);
  EXECUTE format('GRANT SELECT, INSERT ON auditoria TO %I', papel);
END
$$;

-- Down Migration
-- Guarda: com registros, o down é recusado (DROP TABLE não dispara trigger).
-- O papel fica: ele terá o login da app como membro e grants de outras tabelas.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auditoria) THEN
    RAISE EXCEPTION 'auditoria com registros: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

DROP TABLE auditoria;
DROP FUNCTION auditoria_bloquear_alteracao();
