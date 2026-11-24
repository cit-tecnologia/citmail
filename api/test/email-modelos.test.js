// CIT-65, CA7 e registro de modelos: escape do `html`, `texto` e `limparLinha`, o modelo
// `teste_exemplo` renderizado, `validarModelos`, `modelosDoAmbiente` e a classificação do
// erro do `nodemailer`. Funções puras, sem banco nem rede. Dados fictícios.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UnrecoverableError } from 'bullmq';
import { escaparHtml, html, limparLinha, texto } from '../src/email/html.js';
import {
  modelosDoAmbiente, modelosForaDeProducao, modelosPadrao, validarModelos
} from '../src/email/modelos/index.js';
import { testeExemplo } from '../src/email/modelos/teste-exemplo.js';
import { classificarErroEmail, ErroEmail, ErroEmailDefinitivo } from '../src/email/servico.js';

const ATAQUE = '<script>alert(1)</script> & "x"';

describe('CA7: limparLinha', () => {
  const casos = [
    ['a\r\nb', 'ab'],
    ['a\u0000b\u001fc\u007f', 'abc'],
    ['a\u0085b\u009fc', 'abc'],
    ['a b c', 'abc'],
    ['acentuação ok', 'acentuação ok'],
    [null, ''],
    [undefined, ''],
    [12, '12']
  ];
  for (const [entrada, esperado] of casos) {
    test(`CA7: limparLinha(${JSON.stringify(entrada)}) devolve ${JSON.stringify(esperado)}`, () => {
      assert.equal(limparLinha(entrada), esperado);
    });
  }
});

describe('CA7: html (escape automático)', () => {
  test('CA7: escapa & < > " \' em todo valor interpolado', () => {
    assert.equal(String(html`<p>${ATAQUE}</p>`), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>');
    assert.equal(String(html`${"a'b"}`), 'a&#39;b');
  });

  test('CA7: o próprio modelo não é escapado, só os valores', () => {
    assert.equal(String(html`<b>${'x'}</b>`), '<b>x</b>');
  });

  test('CA7: um trecho vindo de outro html não é escapado de novo', () => {
    const interno = html`<i>${'<'}</i>`;
    assert.equal(String(html`<p>${interno}</p>`), '<p><i>&lt;</i></p>');
  });

  test('CA7: uma string com HTML que imita o trecho interno é escapada', () => {
    assert.equal(String(html`${'<i>x</i>'}`), '&lt;i&gt;x&lt;/i&gt;');
  });

  test('CA7: arrays concatenam os itens, cada um escapado', () => {
    assert.equal(String(html`<ul>${['<a>', html`<li>${'&'}</li>`]}</ul>`), '<ul>&lt;a&gt;<li>&amp;</li></ul>');
  });

  test('CA7: null e undefined viram texto vazio', () => {
    assert.equal(String(html`[${null}][${undefined}]`), '[][]');
  });

  test('CA7: número e booleano viram texto', () => {
    assert.equal(String(html`${7}-${false}`), '7-false');
  });

  test('CA7: escaparHtml escapa os cinco caracteres', () => {
    assert.equal(escaparHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('CA7: texto (parte texto puro)', () => {
  test('CA7: o valor sai literal, sem escape de HTML', () => {
    assert.equal(texto`Olá, ${ATAQUE}.`, `Olá, ${ATAQUE}.`);
  });

  test('CA7: CR e LF do valor são removidos e as quebras do próprio modelo ficam', () => {
    assert.equal(texto`a
${'b\r\nc'}
d`, 'a\nbc\nd');
  });

  test('CA7: null, undefined e array seguem a mesma regra', () => {
    assert.equal(texto`[${null}][${undefined}][${['x\n', 'y']}]`, '[][][xy]');
  });
});

describe('CA7: modelo teste_exemplo', () => {
  const v = { nome: ATAQUE };

  test('CA7: o HTML tem o nome escapado e nenhum <script>', () => {
    const saida = String(testeExemplo.html(v));
    assert.ok(saida.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;'));
    assert.ok(!saida.includes('<script'));
  });

  test('CA7: o texto leva o valor literal', () => {
    assert.ok(testeExemplo.texto(v).includes(ATAQUE));
  });

  test('CA7: o assunto do modelo é "Teste do CITMail para <nome>"', () => {
    assert.equal(testeExemplo.assunto({ nome: 'Fulano Ficticio' }), 'Teste do CITMail para Fulano Ficticio');
  });

  test('CA7: carregar com id fora do formato devolve null sem consultar o banco', async () => {
    const cliente = { query: () => assert.fail('não deveria consultar') };
    assert.equal(await testeExemplo.carregar(cliente, { pedidoId: 'nao-e-uuid' }), null);
    assert.equal(await testeExemplo.carregar(cliente, undefined), null);
  });
});

describe('registro de modelos', () => {
  const valido = {
    versao: 1, carregar: () => null, assunto: () => 'a', html: () => 'b', texto: () => 'c'
  };

  test('o registro de produção tem só o compra_confirmada e o de fora de produção acrescenta o teste_exemplo', () => {
    assert.deepEqual(Object.keys(modelosPadrao), ['compra_confirmada']);
    assert.deepEqual(Object.keys(modelosForaDeProducao), ['compra_confirmada', 'teste_exemplo']);
  });

  test('NODE_ENV ausente ou production usa o registro de produção; test e development, o completo', () => {
    assert.equal(modelosDoAmbiente(undefined), modelosPadrao);
    assert.equal(modelosDoAmbiente(''), modelosPadrao);
    assert.equal(modelosDoAmbiente('production'), modelosPadrao);
    assert.equal(modelosDoAmbiente('test'), modelosForaDeProducao);
    assert.equal(modelosDoAmbiente('development'), modelosForaDeProducao);
  });

  test('CA7: modelo sem carregar é recusado com TypeError', () => {
    const { carregar: _omitido, ...semCarregar } = valido;
    assert.throws(() => validarModelos({ modelo_x: semCarregar }), { name: 'TypeError', message: /modelo_x: carregar ausente/ });
  });

  for (const funcao of ['assunto', 'html', 'texto']) {
    test(`modelo sem ${funcao} é recusado com TypeError`, () => {
      assert.throws(() => validarModelos({ modelo_x: { ...valido, [funcao]: undefined } }), { name: 'TypeError', message: new RegExp(`${funcao} ausente`) });
    });
  }

  test('versao que não é inteiro >= 1 é recusada', () => {
    for (const versao of [0, 1.5, '1', undefined]) {
      assert.throws(() => validarModelos({ modelo_x: { ...valido, versao } }), { name: 'TypeError', message: /versao inválida/ });
    }
  });

  test('nome com hífen, maiúscula ou começando por dígito é recusado', () => {
    for (const nome of ['modelo-x', 'Modelo', '1modelo']) {
      assert.throws(() => validarModelos({ [nome]: valido }), { name: 'TypeError', message: /nome inválido/ });
    }
  });

  test('registro que não é objeto é recusado', () => {
    for (const registro of [null, [], 'x']) {
      assert.throws(() => validarModelos(registro), { name: 'TypeError', message: /registro inválido/ });
    }
  });

  test('registro válido passa', () => {
    assert.doesNotThrow(() => validarModelos({ modelo_x: valido }));
  });
});

describe('CA3: classificarErroEmail e erros relançados', () => {
  test('5xx em RCPT (EENVELOPE) é definitivo, com o código SMTP como erroCodigo', () => {
    assert.deepEqual(classificarErroEmail({ code: 'EENVELOPE', responseCode: 550 }), {
      code: 'EENVELOPE', responseCode: 550, erroCodigo: '550', definitivo: true
    });
  });

  test('5xx em DATA (EMESSAGE) é definitivo', () => {
    assert.equal(classificarErroEmail({ code: 'EMESSAGE', responseCode: 554 }).definitivo, true);
  });

  test('4xx em RCPT não é definitivo', () => {
    const r = classificarErroEmail({ code: 'EENVELOPE', responseCode: 451 });
    assert.equal(r.definitivo, false);
    assert.equal(r.erroCodigo, '451');
  });

  test('5xx de autenticação (EAUTH) não é definitivo', () => {
    assert.equal(classificarErroEmail({ code: 'EAUTH', responseCode: 535 }).definitivo, false);
  });

  test('erro de rede sem responseCode usa o code do nodemailer', () => {
    assert.equal(classificarErroEmail({ code: 'ECONNECTION' }).erroCodigo, 'ECONNECTION');
  });

  test('erro sem código vira ERRO_DESCONHECIDO', () => {
    assert.equal(classificarErroEmail(new Error('qualquer')).erroCodigo, 'ERRO_DESCONHECIDO');
    assert.equal(classificarErroEmail(null).erroCodigo, 'ERRO_DESCONHECIDO');
  });

  test('code fora do formato e responseCode fora de 100 a 599 são descartados', () => {
    const r = classificarErroEmail({ code: 'fulano@exemplo.test', responseCode: 99999 });
    assert.equal(r.code, undefined);
    assert.equal(r.responseCode, undefined);
    assert.equal(r.erroCodigo, 'ERRO_DESCONHECIDO');
  });

  test('ErroEmail leva só code e responseCode, sem cause', () => {
    const erro = new ErroEmail({ code: 'EENVELOPE', responseCode: 451 });
    assert.equal(erro.name, 'ErroEmail');
    assert.equal(erro.message, 'falha no envio de e-mail');
    assert.equal(erro.code, 'EENVELOPE');
    assert.equal(erro.responseCode, 451);
    assert.equal(erro.cause, undefined);
    assert.ok(!(erro instanceof UnrecoverableError));
  });

  test('ErroEmailDefinitivo é UnrecoverableError com o mesmo nome público', () => {
    const erro = new ErroEmailDefinitivo({ code: 'EENVELOPE', responseCode: 550 });
    assert.ok(erro instanceof UnrecoverableError);
    assert.equal(erro.name, 'ErroEmail');
    assert.equal(erro.cause, undefined);
  });
});
