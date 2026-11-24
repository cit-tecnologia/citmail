// Auxiliares dos testes do e-mail transacional (CIT-65): pedido semeado, pedido de envio
// (`solicitarEmail` numa transação, como o consumidor) e leitura da linha de `email_envio`.
// Só dados fictícios.
import { solicitarEmail } from '../src/email/servico.js';
import { modelosForaDeProducao } from '../src/email/modelos/index.js';
import { semearPedido } from './webhook-fixtures.js';

export const ENDERECO = 'fulano@exemplo.test';
export const NOME = 'Fulano Ficticio';
export const ASSUNTO = `Teste do CITMail para ${NOME}`;
export const REMETENTE = 'CITMail <naoresponda@exemplo.test>';
export const SENHA_SMTP = 'SenhaSmtpFicticia-123';

let contador = 0;

/** `solicitarEmail` na transação de um cliente do papel da aplicação (`banco.app`). */
export async function solicitar(banco, dados, modelos = modelosForaDeProducao) {
  const cliente = await banco.app.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await solicitarEmail(cliente, dados, modelos);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

/** Pedido semeado + linha `pendente` do `teste_exemplo` para ele. Devolve `{ id, pedidoId }`. */
export async function pedirEnvio(banco, { email = ENDERECO, nome } = {}) {
  const pedido = await semearPedido(banco.admin, { email, assinaturas: {} });
  if (nome !== undefined) await banco.admin.query('UPDATE pedido SET contato_nome = $1 WHERE id = $2', [nome, pedido.pedidoId]);
  contador += 1;
  const { id } = await solicitar(banco, {
    chaveIdempotencia: `teste_exemplo-${contador}`, modelo: 'teste_exemplo', refs: { pedidoId: pedido.pedidoId }
  });
  return { id, pedidoId: pedido.pedidoId };
}

export async function linhaDe(banco, id) {
  return (await banco.admin.query('SELECT * FROM email_envio WHERE id = $1', [id])).rows[0];
}
