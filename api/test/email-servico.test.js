// CIT-65, serviço do e-mail transacional sem Redis nem SMTP real: `solicitarEmail` (CA6 a,
// entrada inválida), o repositório (CA6 f, parados CA9) e `criarHandlerEmail` com um transporte
// falso contra um banco temporário migrado, no papel da aplicação. Dados fictícios.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { criarLogger } from '../src/log.js';
import { criarHandlerEmail, ErroEmail, ErroEmailDefinitivo, solicitarEmail } from '../src/email/servico.js';
import { modelosDoAmbiente, modelosForaDeProducao } from '../src/email/modelos/index.js';
import { reiniciarEnvio } from '../src/email/repositorio.js';
import { criarCapturaDeLog } from './auxiliares.js';
import { ENDERECO, linhaDe, NOME, pedirEnvio as pedirEnvioEm, REMETENTE, solicitar as solicitarEm } from './email-fixtures.js';
import { criarBancoWebhook } from './webhook-fixtures.js';

let banco;
let captura;
let log;
let contador = 0;

before(async () => {
  banco = await criarBancoWebhook();
});

after(() => banco.fechar());

beforeEach(async () => {
  await banco.admin.query('TRUNCATE email_envio, evento_processado, evento, assinatura, pedido_dominio, pedido, cliente CASCADE');
  captura = criarCapturaDeLog();
  log = criarLogger({ level: 'info', stream: captura.stream });
});

const solicitar = (dados, modelos) => solicitarEm(banco, dados, modelos);
const pedirEnvio = (opcoes) => pedirEnvioEm(banco, opcoes);
const linha = (id) => linhaDe(banco, id);

function transporteFalso({ ligado = true, erro, messageId = '<id-1@exemplo.test>' } = {}) {
  const enviadas = [];
  return {
    ligado,
    enviadas,
    async enviar(mensagem) {
      enviadas.push(mensagem);
      if (erro) throw erro;
      return { messageId };
    },
    close() {}
  };
}

function criarHandler(transporte, extra = {}) {
  return criarHandlerEmail({
    pool: banco.app, modelos: modelosForaDeProducao, transporte, remetente: REMETENTE, log, ...extra
  });
}

async function erroDe(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  return undefined;
}

describe('CA6: solicitarEmail', () => {
  test('CA6: a mesma chave de idempotência em duas transações grava uma só linha', async () => {
    const { pedidoId } = await pedirEnvio();
    const dados = { chaveIdempotencia: 'mesma-chave', modelo: 'teste_exemplo', refs: { pedidoId } };
    const primeira = await solicitar(dados);
    const segunda = await solicitar(dados);
    assert.equal(primeira.criado, true);
    assert.equal(segunda.criado, false);
    assert.equal(segunda.id, primeira.id);
    assert.equal((await banco.admin.query("SELECT count(*)::int AS n FROM email_envio WHERE chave_idempotencia = 'mesma-chave'")).rows[0].n, 1);
  });

  test('CA6: duas chaves diferentes para o mesmo evento gravam duas linhas', async () => {
    const evento = await banco.admin.query(
      `INSERT INTO evento (nome, agregado_tipo, agregado_id, chave_idempotencia)
       VALUES ('pedido_pago', 'pedido', 'p1', 'evt-servico-1') RETURNING id`
    );
    const eventoId = evento.rows[0].id;
    await solicitar({ eventoId, chaveIdempotencia: 'a-1', modelo: 'teste_exemplo' });
    await solicitar({ eventoId, chaveIdempotencia: 'a-2', modelo: 'teste_exemplo' });
    assert.equal((await banco.admin.query('SELECT count(*)::int AS n FROM email_envio WHERE evento_id = $1', [eventoId])).rows[0].n, 2);
  });

  test('a linha nasce pendente com a versão atual do modelo e só os ids em refs', async () => {
    const { id, pedidoId } = await pedirEnvio();
    const gravada = await linha(id);
    assert.equal(gravada.estado, 'pendente');
    assert.equal(gravada.versao_modelo, 1);
    assert.equal(gravada.geracao, 1);
    assert.deepEqual(gravada.refs, { pedidoId });
    assert.equal(gravada.destinatario_mascarado, null);
  });

  test('se a transação do consumidor volta atrás, a linha não existe', async () => {
    const cliente = await banco.app.connect();
    try {
      await cliente.query('BEGIN');
      await solicitarEmail(cliente, { chaveIdempotencia: 'rollback-1', modelo: 'teste_exemplo' }, modelosForaDeProducao);
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
    assert.equal((await banco.admin.query('SELECT count(*)::int AS n FROM email_envio')).rows[0].n, 0);
  });

  test('o Pool no lugar do cliente da transação é recusado antes de qualquer consulta', async () => {
    await assert.rejects(
      solicitarEmail(banco.app, { chaveIdempotencia: 'k', modelo: 'teste_exemplo' }, modelosForaDeProducao),
      { name: 'TypeError', message: /use o cliente da transação/ }
    );
    assert.equal((await banco.admin.query('SELECT count(*)::int AS n FROM email_envio')).rows[0].n, 0);
  });

  const invalidos = [
    ['modelo fora do registro', { chaveIdempotencia: 'k', modelo: 'inexistente' }, /modelo fora do registro/],
    ['modelo de prototype (constructor)', { chaveIdempotencia: 'k', modelo: 'constructor' }, /modelo fora do registro/],
    ['chave com espaço', { chaveIdempotencia: 'a b', modelo: 'teste_exemplo' }, /chaveIdempotencia inválida/],
    ['chave vazia', { chaveIdempotencia: '', modelo: 'teste_exemplo' }, /chaveIdempotencia inválida/],
    ['eventoId que não é UUID', { eventoId: 'x', chaveIdempotencia: 'k', modelo: 'teste_exemplo' }, /eventoId inválido/],
    ['refs com e-mail como valor', { chaveIdempotencia: 'k', modelo: 'teste_exemplo', refs: { pedidoId: ENDERECO } }, /refs com valor que não é id/],
    ['refs com chave sensível', { chaveIdempotencia: 'k', modelo: 'teste_exemplo', refs: { email: 'abc' } }, /refs com chave inválida/],
    ['refs com chave destinatario', { chaveIdempotencia: 'k', modelo: 'teste_exemplo', refs: { destinatario: 'abc' } }, /refs com chave inválida/],
    ['refs aninhado', { chaveIdempotencia: 'k', modelo: 'teste_exemplo', refs: { pedidoId: { a: 1 } } }, /refs com valor que não é id/],
    ['refs que é array', { chaveIdempotencia: 'k', modelo: 'teste_exemplo', refs: [1] }, /refs deve ser objeto simples/],
    ['dados que não é objeto', 'texto', /dados inválidos/]
  ];
  for (const [descricao, dados, mensagem] of invalidos) {
    test(`entrada inválida (${descricao}) lança TypeError sem gravar nem citar o valor`, async () => {
      const erro = await erroDe(solicitar(dados));
      assert.equal(erro?.name, 'TypeError');
      assert.match(erro.message, mensagem);
      assert.ok(!erro.message.includes(ENDERECO));
      assert.equal((await banco.admin.query('SELECT count(*)::int AS n FROM email_envio')).rows[0].n, 0);
    });
  }

  test('o registro de produção (padrão do ambiente) não tem o teste_exemplo', async () => {
    await assert.rejects(
      solicitar({ chaveIdempotencia: 'k', modelo: 'teste_exemplo' }, modelosDoAmbiente('production')),
      { name: 'TypeError', message: /modelo fora do registro/ }
    );
  });
});

describe('CA6: reiniciarEnvio (reset por geração)', () => {
  test('CA6: reiniciar linha enviada altera 0 linhas e mantém a geração', async () => {
    const { id } = await pedirEnvio();
    await banco.admin.query("UPDATE email_envio SET estado = 'enviado' WHERE id = $1", [id]);
    assert.equal(await reiniciarEnvio(banco.app, id), false);
    assert.equal((await linha(id)).geracao, 1);
  });

  test('CA6: reiniciar linha falhou volta a pendente, soma a geração e zera tentativas, erro e datas', async () => {
    const { id } = await pedirEnvio();
    await banco.admin.query(
      `UPDATE email_envio SET estado = 'falhou', tentativas = 3, erro_codigo = '451', enfileirado_em = now(),
              alertado_parado_em = now() WHERE id = $1`, [id]
    );
    assert.equal(await reiniciarEnvio(banco.app, id), true);
    const depois = await linha(id);
    assert.equal(depois.estado, 'pendente');
    assert.equal(depois.geracao, 2);
    assert.equal(depois.tentativas, 0);
    assert.equal(depois.erro_codigo, null);
    assert.equal(depois.enfileirado_em, null);
    assert.equal(depois.alertado_parado_em, null);
  });

  test('CA6: reiniciar linha pendente ou inexistente devolve false', async () => {
    const { id } = await pedirEnvio();
    assert.equal(await reiniciarEnvio(banco.app, id), false);
    assert.equal(await reiniciarEnvio(banco.app, randomUUID()), false);
  });
});

describe('handler do job email_enviar', () => {
  test('CA1: envia com remetente, destinatário, assunto e as duas partes e grava enviado com máscara e message_id', async () => {
    const { id } = await pedirEnvio();
    const transporte = transporteFalso();
    await criarHandler(transporte, { responderPara: 'suporte@exemplo.test' })({ log }, { envioId: id, geracao: 1 });

    assert.equal(transporte.enviadas.length, 1);
    const mensagem = transporte.enviadas[0];
    assert.equal(mensagem.from, REMETENTE);
    assert.equal(mensagem.to, ENDERECO);
    assert.equal(mensagem.subject, `Teste do CITMail para ${NOME}`);
    assert.ok(mensagem.html.includes(NOME));
    assert.ok(mensagem.text.includes(NOME));
    assert.equal(mensagem.replyTo, 'suporte@exemplo.test');

    const gravada = await linha(id);
    assert.equal(gravada.estado, 'enviado');
    assert.equal(gravada.destinatario_mascarado, 'f***@exemplo.test');
    assert.equal(gravada.message_id, '<id-1@exemplo.test>');
    assert.equal(gravada.tentativas, 1);
    assert.ok(gravada.enviado_em instanceof Date);
    assert.equal(gravada.erro_codigo, null);
  });

  test('sem responderPara a mensagem não leva replyTo', async () => {
    const { id } = await pedirEnvio();
    const transporte = transporteFalso();
    await criarHandler(transporte)({ log }, { envioId: id, geracao: 1 });
    assert.ok(!('replyTo' in transporte.enviadas[0]));
  });

  test('message_id maior que 255 caracteres é truncado', async () => {
    const { id } = await pedirEnvio();
    await criarHandler(transporteFalso({ messageId: `<${'a'.repeat(400)}@exemplo.test>` }))({ log }, { envioId: id, geracao: 1 });
    assert.equal((await linha(id)).message_id.length, 255);
  });

  test('CA6: job de geração antiga conclui sem enviar e sem alterar a linha', async () => {
    const { id } = await pedirEnvio();
    await banco.admin.query('UPDATE email_envio SET geracao = 2 WHERE id = $1', [id]);
    const transporte = transporteFalso();
    await criarHandler(transporte)({ log }, { envioId: id, geracao: 1 });
    assert.equal(transporte.enviadas.length, 0);
    assert.equal((await linha(id)).estado, 'pendente');
  });

  test('CA6: job entregue de novo depois de enviado não envia outra vez', async () => {
    const { id } = await pedirEnvio();
    const transporte = transporteFalso();
    const handler = criarHandler(transporte);
    await handler({ log }, { envioId: id, geracao: 1 });
    await handler({ log }, { envioId: id, geracao: 1 });
    assert.equal(transporte.enviadas.length, 1);
    assert.equal((await linha(id)).tentativas, 1);
  });

  test('CA8: transporte desligado grava nao_enviado sem tentativa, sem erro e sem enviar', async () => {
    const { id } = await pedirEnvio();
    const transporte = transporteFalso({ ligado: false });
    await criarHandler(transporte)({ log }, { envioId: id, geracao: 1 });
    const gravada = await linha(id);
    assert.equal(gravada.estado, 'nao_enviado');
    assert.equal(gravada.tentativas, 0);
    assert.equal(gravada.erro_codigo, null);
    assert.equal(transporte.enviadas.length, 0);
  });

  test('CA2(e): pedido inexistente (carregar devolve null) grava nao_enviado com SEM_DESTINATARIO e conclui', async () => {
    contador += 1;
    const { id } = await solicitar({ chaveIdempotencia: `sem-dest-${contador}`, modelo: 'teste_exemplo', refs: { pedidoId: randomUUID() } });
    const transporte = transporteFalso();
    await criarHandler(transporte)({ log }, { envioId: id, geracao: 1 });
    const gravada = await linha(id);
    assert.equal(gravada.estado, 'nao_enviado');
    assert.equal(gravada.erro_codigo, 'SEM_DESTINATARIO');
    assert.equal(transporte.enviadas.length, 0);
  });

  test('CA2(e): destinatário só com caracteres de controle também é SEM_DESTINATARIO', async () => {
    const { id } = await pedirEnvio({ email: ENDERECO });
    const modelos = {
      teste_exemplo: { ...modelosForaDeProducao.teste_exemplo, carregar: async () => ({ destinatario: '\r\n', variaveis: {} }) }
    };
    await criarHandler(transporteFalso(), { modelos })({ log }, { envioId: id, geracao: 1 });
    assert.equal((await linha(id)).erro_codigo, 'SEM_DESTINATARIO');
  });

  test('CA2(f): modelo fora do registro lança UnrecoverableError e não toca a linha', async () => {
    const { id } = await pedirEnvio();
    const erro = await erroDe(criarHandler(transporteFalso(), { modelos: {} })({ log }, { envioId: id, geracao: 1 }));
    assert.ok(erro instanceof UnrecoverableError);
    assert.equal((await linha(id)).estado, 'pendente');
  });

  const entradasInvalidas = [
    ['envioId que não é UUID', { envioId: 'x', geracao: 1 }],
    ['envioId ausente', { geracao: 1 }],
    ['geração zero', { envioId: randomUUID(), geracao: 0 }],
    ['geração em texto', { envioId: randomUUID(), geracao: '1' }],
    ['linha inexistente', { envioId: randomUUID(), geracao: 1 }]
  ];
  for (const [descricao, dados] of entradasInvalidas) {
    test(`job com ${descricao} lança UnrecoverableError`, async () => {
      const erro = await erroDe(criarHandler(transporteFalso())({ log }, dados));
      assert.ok(erro instanceof UnrecoverableError);
    });
  }

  test('o registro inválido é recusado ao criar o handler', () => {
    assert.throws(() => criarHandler(transporteFalso(), { modelos: { x: {} } }), { name: 'TypeError' });
  });

  test('CA2(c): erro 4xx antes da última tentativa relança ErroEmail, soma a tentativa e mantém pendente', async () => {
    const { id } = await pedirEnvio();
    const origem = Object.assign(new Error(`451 <${ENDERECO}> tente depois`), { code: 'EENVELOPE', responseCode: 451, response: ENDERECO });
    const erro = await erroDe(criarHandler(transporteFalso({ erro: origem }))({ log, tentativa: { feita: 0, maxima: 3 } }, { envioId: id, geracao: 1 }));
    assert.ok(erro instanceof ErroEmail);
    assert.ok(!(erro instanceof UnrecoverableError));
    assert.equal(erro.responseCode, 451);
    const gravada = await linha(id);
    assert.equal(gravada.estado, 'pendente');
    assert.equal(gravada.tentativas, 1);
    assert.equal(gravada.erro_codigo, '451');
    assert.equal(gravada.destinatario_mascarado, 'f***@exemplo.test');
  });

  test('CA2(c): erro 4xx na última tentativa grava falhou antes de relançar', async () => {
    const { id } = await pedirEnvio();
    const origem = Object.assign(new Error('x'), { code: 'EENVELOPE', responseCode: 451 });
    const erro = await erroDe(criarHandler(transporteFalso({ erro: origem }))({ log, tentativa: { feita: 2, maxima: 3 } }, { envioId: id, geracao: 1 }));
    assert.ok(erro instanceof ErroEmail);
    assert.equal((await linha(id)).estado, 'falhou');
  });

  test('CA2(d): 5xx em RCPT grava falhou na hora e lança ErroEmailDefinitivo (sem novas tentativas)', async () => {
    const { id } = await pedirEnvio();
    const origem = Object.assign(new Error(`550 <${ENDERECO}>`), { code: 'EENVELOPE', responseCode: 550 });
    const erro = await erroDe(criarHandler(transporteFalso({ erro: origem }))({ log, tentativa: { feita: 0, maxima: 3 } }, { envioId: id, geracao: 1 }));
    assert.ok(erro instanceof ErroEmailDefinitivo);
    assert.ok(erro instanceof UnrecoverableError);
    const gravada = await linha(id);
    assert.equal(gravada.estado, 'falhou');
    assert.equal(gravada.erro_codigo, '550');
    assert.equal(gravada.tentativas, 1);
  });

  test('erro sem código grava ERRO_DESCONHECIDO', async () => {
    const { id } = await pedirEnvio();
    const erro = await erroDe(criarHandler(transporteFalso({ erro: new Error('qualquer') }))({ log, tentativa: { feita: 0, maxima: 3 } }, { envioId: id, geracao: 1 }));
    assert.ok(erro instanceof ErroEmail);
    assert.equal((await linha(id)).erro_codigo, 'ERRO_DESCONHECIDO');
  });

  test('sem contexto.tentativa a falha não vira falhou (a fila decide)', async () => {
    const { id } = await pedirEnvio();
    const origem = Object.assign(new Error('x'), { code: 'EENVELOPE', responseCode: 451 });
    await erroDe(criarHandler(transporteFalso({ erro: origem }))({ log }, { envioId: id, geracao: 1 }));
    assert.equal((await linha(id)).estado, 'pendente');
  });

  test('CA3: o erro relançado e o log não carregam o endereço, o nome nem o assunto', async () => {
    const { id } = await pedirEnvio();
    const origem = Object.assign(new Error(`451 <${ENDERECO}> ${NOME}`), {
      code: 'EENVELOPE', responseCode: 451, response: `451 ${ENDERECO}`, rejected: [ENDERECO], command: `RCPT TO:<${ENDERECO}>`
    });
    const erro = await erroDe(criarHandler(transporteFalso({ erro: origem }))({ log, tentativa: { feita: 0, maxima: 3 } }, { envioId: id, geracao: 1 }));
    const visivel = JSON.stringify({ ...erro, message: erro.message, name: erro.name, stack: erro.stack, cause: erro.cause });
    for (const proibido of [ENDERECO, NOME, `Teste do CITMail para ${NOME}`]) {
      assert.ok(!visivel.includes(proibido), `erro com ${proibido}`);
      assert.ok(!captura.texto().includes(proibido), `log com ${proibido}`);
    }
  });

  test('CA3: o log de envio com sucesso tem só ids e estado', async () => {
    const { id } = await pedirEnvio();
    await criarHandler(transporteFalso())({ log }, { envioId: id, geracao: 1 });
    const texto = captura.texto();
    assert.ok(!texto.includes(ENDERECO));
    assert.ok(!texto.includes(NOME));
    const registro = captura.linhas().find((l) => l.msg === 'e-mail enviado');
    assert.equal(registro.envioId, id);
    assert.equal(registro.modelo, 'teste_exemplo');
    assert.equal(registro.estado, 'enviado');
  });

  test('CA7: assunto com CR/LF e Bcc injetado sai sem quebra de linha', async () => {
    const { id } = await pedirEnvio();
    const modelos = {
      teste_exemplo: {
        ...modelosForaDeProducao.teste_exemplo,
        assunto: () => 'Ola\r\nBcc: outro@exemplo.test'
      }
    };
    const transporte = transporteFalso();
    await criarHandler(transporte, { modelos })({ log }, { envioId: id, geracao: 1 });
    const mensagem = transporte.enviadas[0];
    assert.ok(!/[\r\n]/.test(mensagem.subject));
    assert.equal(mensagem.subject, 'OlaBcc: outro@exemplo.test');
    assert.deepEqual(mensagem.envelope, { from: 'naoresponda@exemplo.test', to: [ENDERECO] });
  });

  const DESTINATARIOS_INVALIDOS = [
    ['com Bcc injetado por CR/LF', `${ENDERECO}\r\nBcc: outro@exemplo.test`],
    ['com lista por vírgula', `${ENDERECO},outro@exemplo.test`],
    ['com lista por ponto e vírgula', `${ENDERECO};outro@exemplo.test`],
    ['com nome de exibição entre <>', `Fulano <${ENDERECO}>`],
    ['com aspas', `"fulano"@exemplo.test`],
    ['com espaço', 'fulano @exemplo.test'],
    ['sem arroba', 'fulano.exemplo.test'],
    ['com dois arrobas', 'a@b@exemplo.test']
  ];
  for (const [descricao, destinatario] of DESTINATARIOS_INVALIDOS) {
    test(`CA7: destinatário ${descricao} grava nao_enviado/SEM_DESTINATARIO sem enviar nem relançar`, async () => {
      const { id } = await pedirEnvio();
      const modelos = {
        teste_exemplo: { ...modelosForaDeProducao.teste_exemplo, carregar: async () => ({ destinatario, variaveis: { nome: 'x' } }) }
      };
      const transporte = transporteFalso();
      await criarHandler(transporte, { modelos })({ log, tentativa: { feita: 0, maxima: 3 } }, { envioId: id, geracao: 1 });
      const gravada = await linha(id);
      assert.equal(gravada.estado, 'nao_enviado');
      assert.equal(gravada.erro_codigo, 'SEM_DESTINATARIO');
      assert.equal(transporte.enviadas.length, 0);
      assert.ok(!captura.texto().includes('outro@exemplo.test'));
    });
  }

  test('CA7: o envelope leva só o remetente e o destinatário único', async () => {
    const { id } = await pedirEnvio();
    const transporte = transporteFalso();
    await criarHandler(transporte)({ log }, { envioId: id, geracao: 1 });
    assert.deepEqual(transporte.enviadas[0].envelope, { from: 'naoresponda@exemplo.test', to: [ENDERECO] });
  });

  test('CA7: modelo cujo html() devolve string comum falha com UnrecoverableError "modelo sem escape" e não envia', async () => {
    const { id } = await pedirEnvio();
    const modelos = {
      teste_exemplo: { ...modelosForaDeProducao.teste_exemplo, html: (v) => `<p>${v.nome}</p>` }
    };
    const transporte = transporteFalso();
    const erro = await erroDe(criarHandler(transporte, { modelos })({ log }, { envioId: id, geracao: 1 }));
    assert.ok(erro instanceof UnrecoverableError);
    assert.equal(erro.message, 'modelo sem escape');
    assert.equal(transporte.enviadas.length, 0);
    assert.equal((await linha(id)).estado, 'pendente');
  });

  test('CA6: o segundo job conclui sem reenviar quando outra execução já marcou a linha (UPDATE condicionado)', async () => {
    const { id } = await pedirEnvio();
    const transporte = transporteFalso();
    transporte.enviar = async (mensagem) => {
      transporte.enviadas.push(mensagem);
      await banco.admin.query("UPDATE email_envio SET estado = 'falhou' WHERE id = $1", [id]);
      return { messageId: '<x@exemplo.test>' };
    };
    await criarHandler(transporte)({ log }, { envioId: id, geracao: 1 });
    assert.equal((await linha(id)).estado, 'falhou');
    assert.ok(captura.linhas().some((l) => l.msg === 'e-mail enviado, mas a linha mudou antes do registro'));
  });
});
