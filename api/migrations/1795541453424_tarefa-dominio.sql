-- Up Migration
-- Tarefa manual de registro e renovação de domínio novo (E4-H4; CIT-77): `tarefa_dominio`
-- (uma tarefa `registro` por `pedido_dominio` novo, aberta no `dominio_pago`, e uma
-- `renovacao` por vencimento no Registro.br, aberta em D-30), as datas de registro em
-- `pedido_dominio` e `pedido.dominio_registrado_em` (todos os domínios novos do pedido
-- registrados). A ação `dados_titular_consultados` entra no CHECK da auditoria (mesma
-- lista de `src/auditoria/vocabulario.js`).
-- O papel `<banco>_aplicacao` já existe: nasce na migração da auditoria (CIT-58).

-- `referencia_expira_em`: vencimento que a renovação cobre (nulo no registro).
-- `situacao_fatura`: fatura anual dos domínios na abertura da renovação (nula no registro).
-- `alertada_em`: aviso de abertura enfileirado; `ultimo_lembrete_em`: último lembrete.
CREATE TABLE tarefa_dominio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_dominio_id uuid NOT NULL REFERENCES pedido_dominio (id),
  tipo text NOT NULL CHECK (tipo IN ('registro', 'renovacao')),
  referencia_expira_em date,
  situacao_fatura text CHECK (situacao_fatura IN ('paga', 'pendente')),
  aberta_em timestamptz NOT NULL DEFAULT now(),
  concluida_em timestamptz,
  alertada_em timestamptz,
  ultimo_lembrete_em timestamptz,
  CHECK ((tipo = 'registro') = (referencia_expira_em IS NULL)),
  CHECK ((tipo = 'renovacao') = (situacao_fatura IS NOT NULL)),
  -- NULLS NOT DISTINCT: uma só tarefa `registro` (referência nula) por domínio.
  UNIQUE NULLS NOT DISTINCT (pedido_dominio_id, tipo, referencia_expira_em)
);

-- Laço do worker e `listar`: só as abertas; aviso de abertura: só as não alertadas.
CREATE INDEX tarefa_dominio_aberta_idx ON tarefa_dominio (aberta_em) WHERE concluida_em IS NULL;
CREATE INDEX tarefa_dominio_nao_alertada_idx ON tarefa_dominio (pedido_dominio_id) WHERE alertada_em IS NULL;

-- Nuláveis, sem backfill: só o registro manual (CLI) as preenche.
ALTER TABLE pedido_dominio ADD COLUMN registrado_em timestamptz;
ALTER TABLE pedido_dominio ADD COLUMN registro_expira_em date;
ALTER TABLE pedido ADD COLUMN dominio_registrado_em timestamptz;

-- Renovação D-30: só os domínios com vencimento conhecido.
CREATE INDEX pedido_dominio_registro_expira_idx ON pedido_dominio (registro_expira_em)
  WHERE registro_expira_em IS NOT NULL;

-- Ação nova da auditoria: leitura dos dados do titular pela CLI (LGPD).
ALTER TABLE auditoria DROP CONSTRAINT auditoria_acao_check;
ALTER TABLE auditoria ADD CONSTRAINT auditoria_acao_check CHECK (acao IN (
  'login', 'login_falhou', 'conta_bloqueada', 'caixa_criada', 'caixa_excluida', 'senha_trocada',
  'cadastro_alterado', 'assinatura_cancelada', 'dados_excluidos', 'conta_suspensa', 'conta_reativada',
  'dominio_registrado_manualmente', 'dados_titular_consultados'
));

-- O REVOKE explícito ao papel anula um ALTER DEFAULT PRIVILEGES futuro. A aplicação insere
-- só as colunas do consumidor e do laço, altera só as datas de conclusão, aviso e lembrete
-- (nunca `tipo`, a referência nem a situação) e não apaga. Em `pedido_dominio` e `pedido`,
-- UPDATE só nas datas de registro.
DO $$
DECLARE
  papel text := current_database() || '_aplicacao';
BEGIN
  EXECUTE format('REVOKE ALL ON tarefa_dominio FROM PUBLIC, %I', papel);
  EXECUTE format('GRANT SELECT ON tarefa_dominio TO %I', papel);
  EXECUTE format(
    'GRANT INSERT (pedido_dominio_id, tipo, referencia_expira_em, situacao_fatura) ON tarefa_dominio TO %I',
    papel
  );
  EXECUTE format('GRANT UPDATE (concluida_em, alertada_em, ultimo_lembrete_em) ON tarefa_dominio TO %I', papel);
  EXECUTE format('GRANT UPDATE (registrado_em, registro_expira_em) ON pedido_dominio TO %I', papel);
  EXECUTE format('GRANT UPDATE (dominio_registrado_em) ON pedido TO %I', papel);
END
$$;

-- Down Migration
-- Guarda: com tarefas, datas de registro gravadas ou auditoria da ação nova, o down é
-- recusado (perderia o histórico do registro manual). O LOCK impede uma escrita entre a
-- conferência e o DROP.
LOCK TABLE tarefa_dominio, pedido_dominio, pedido, auditoria IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tarefa_dominio)
     OR EXISTS (SELECT 1 FROM pedido_dominio WHERE registrado_em IS NOT NULL OR registro_expira_em IS NOT NULL)
     OR EXISTS (SELECT 1 FROM pedido WHERE dominio_registrado_em IS NOT NULL)
     OR EXISTS (SELECT 1 FROM auditoria WHERE acao = 'dados_titular_consultados') THEN
    RAISE EXCEPTION 'tarefas de domínio com registros: down recusado' USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE auditoria DROP CONSTRAINT auditoria_acao_check;
ALTER TABLE auditoria ADD CONSTRAINT auditoria_acao_check CHECK (acao IN (
  'login', 'login_falhou', 'conta_bloqueada', 'caixa_criada', 'caixa_excluida', 'senha_trocada',
  'cadastro_alterado', 'assinatura_cancelada', 'dados_excluidos', 'conta_suspensa', 'conta_reativada',
  'dominio_registrado_manualmente'
));

-- O DROP COLUMN leva junto o índice parcial e os GRANT das colunas.
ALTER TABLE pedido DROP COLUMN dominio_registrado_em;
ALTER TABLE pedido_dominio DROP COLUMN registro_expira_em;
ALTER TABLE pedido_dominio DROP COLUMN registrado_em;
DROP TABLE tarefa_dominio;
