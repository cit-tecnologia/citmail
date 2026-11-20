import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirAppTeste } from './auxiliares.js';
import { VERSAO } from '../src/precos/tabela.js';

const ORIGEM_PERMITIDA = 'http://127.0.0.1:4200';

async function orcar(t, payload, opcoes = {}) {
  const { app, fechar } = await construirAppTeste({ comBanco: false, ...opcoes });
  t.after(fechar);
  return app.inject({ method: 'POST', url: '/api/orcamento', payload });
}

function somar(itens, campo) {
  return itens.reduce((soma, item) => soma + item[campo], 0);
}

function itemPorChave(corpo, chave) {
  return corpo.itens.find((item) => item.chave === chave);
}

// CA1 -----------------------------------------------------------------------

const EXEMPLO_CONTRATO = {
  ciclo: 'mensal',
  contas: { '5gb': 5, '25gb': 0, '50gb': 1 },
  addons: {
    talk: 2,
    backup90: 0,
    backup365: 1,
    grupoEmail: 6,
    skybox: { plano: '100gb', quantidade: 2 },
    extraDom: 1,
  },
};

test('CA1: exemplo do contrato responde 200 com itens, avulsos e totais calculados no servidor', async (t) => {
  const resposta = await orcar(t, EXEMPLO_CONTRATO);

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.equal(corpo.versao_tabela, VERSAO);
  assert.equal(corpo.ciclo, 'mensal');
  assert.deepEqual(
    corpo.itens.map((item) => item.chave),
    ['5gb', '50gb', 'talk', 'backup365', 'grupoEmail', 'skybox'],
  );

  assert.deepEqual(itemPorChave(corpo, '5gb'), {
    tipo: 'conta',
    chave: '5gb',
    quantidade: 5,
    unit_atual_centavos: 1000,
    unit_tabela_centavos: 1176,
    unit_cobrado_centavos: 950,
    tabela_centavos: 5880,
    atual_centavos: 5000,
    subtotal_centavos: 4750,
    descontos: [
      { rotulo: '−15% contratação', valor_centavos: 880 },
      { rotulo: '−5% volume', valor_centavos: 250 },
    ],
  });

  const conta50 = itemPorChave(corpo, '50gb');
  assert.equal(conta50.unit_cobrado_centavos, 2500);
  assert.equal(conta50.subtotal_centavos, 2500);
  assert.deepEqual(conta50.descontos.map((d) => d.rotulo), ['−15% contratação']);

  assert.deepEqual(itemPorChave(corpo, 'talk'), {
    tipo: 'addon',
    chave: 'talk',
    quantidade: 2,
    unit_atual_centavos: 470,
    unit_tabela_centavos: 553,
    unit_cobrado_centavos: 470,
    tabela_centavos: 1106,
    atual_centavos: 940,
    subtotal_centavos: 940,
    descontos: [{ rotulo: '−15% contratação', valor_centavos: 166 }],
  });
  assert.equal(itemPorChave(corpo, 'backup365').subtotal_centavos, 1900);
  assert.equal(itemPorChave(corpo, 'grupoEmail').subtotal_centavos, 1200);
  assert.deepEqual(itemPorChave(corpo, 'skybox'), {
    tipo: 'addon',
    chave: 'skybox',
    plano: '100gb',
    quantidade: 2,
    unit_atual_centavos: 2870,
    unit_tabela_centavos: 3376,
    unit_cobrado_centavos: 2870,
    tabela_centavos: 6752,
    atual_centavos: 5740,
    subtotal_centavos: 5740,
    descontos: [{ rotulo: '−15% contratação', valor_centavos: 1012 }],
  });
  for (const item of corpo.itens) {
    if (item.chave !== 'skybox') assert.equal('plano' in item, false, `${item.chave} não deveria ter plano`);
  }

  assert.deepEqual(corpo.avulsos, [
    { tipo: 'dominio_extra', quantidade: 1, periodo: 'ano', unit_centavos: 7900, subtotal_centavos: 7900 },
  ]);

  const tabela = somar(corpo.itens, 'tabela_centavos');
  assert.deepEqual(corpo.totais, {
    recorrente_mensal_centavos: 17030,
    recorrente_ciclo_centavos: 17030,
    tabela_mensal_centavos: tabela,
    economia_mensal_centavos: tabela - 17030,
    avulso_centavos: 7900,
  });
  assert.equal(somar(corpo.itens, 'subtotal_centavos'), 17030);
});

test('CA1: anual com 4×25 GB cobra −20% anual, sem volume, e o ciclo vale 12 meses', async (t) => {
  const resposta = await orcar(t, { ciclo: 'anual', contas: { '25gb': 4 } });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  const item = itemPorChave(corpo, '25gb');
  assert.equal(item.unit_cobrado_centavos, 1280);
  assert.deepEqual(item.descontos.map((d) => d.rotulo), ['−15% contratação', '−20% anual']);
  assert.equal(corpo.totais.recorrente_mensal_centavos, 5120);
  assert.equal(corpo.totais.recorrente_ciclo_centavos, 61440);
});

test('CA1: mensal com 4×25 GB fica sem volume; com 5×25 GB ganha −5% volume', async (t) => {
  const quatro = await orcar(t, { ciclo: 'mensal', contas: { '25gb': 4 } });
  const cinco = await orcar(t, { ciclo: 'mensal', contas: { '25gb': 5 } });

  assert.equal(itemPorChave(quatro.json(), '25gb').unit_cobrado_centavos, 1600);
  assert.equal(itemPorChave(quatro.json(), '25gb').descontos.length, 1);
  assert.equal(itemPorChave(cinco.json(), '25gb').unit_cobrado_centavos, 1520);
  assert.deepEqual(itemPorChave(cinco.json(), '25gb').descontos.map((d) => d.rotulo), ['−15% contratação', '−5% volume']);
});

for (const [tipo, atual] of [['5gb', 1000], ['25gb', 1600], ['50gb', 2500]]) {
  for (const qtd of [4, 5]) {
    for (const ciclo of ['mensal', 'anual']) {
      test(`CA1: ${qtd}×${tipo} ${ciclo} soma o subtotal da cascata`, async (t) => {
        const resposta = await orcar(t, { ciclo, contas: { [tipo]: qtd } });

        assert.equal(resposta.statusCode, 200);
        const pct = ciclo === 'anual' ? 20 : (qtd >= 5 ? 5 : 0);
        const unit = Math.round(atual * (100 - pct) / 100);
        const item = itemPorChave(resposta.json(), tipo);
        assert.equal(item.unit_atual_centavos, atual);
        assert.equal(item.subtotal_centavos, qtd * unit);
        assert.equal(item.tabela_centavos, qtd * Math.round(atual * 100 / 85));
      });
    }
  }
}

for (const [chave, atual] of [['talk', 470], ['backup90', 600], ['backup365', 1900], ['grupoEmail', 200]]) {
  test(`CA1: add-on ${chave} ×3 só tem o desconto de contratação`, async (t) => {
    const resposta = await orcar(t, { ciclo: 'anual', contas: { '25gb': 3 }, addons: { [chave]: 3 } });

    assert.equal(resposta.statusCode, 200);
    const item = itemPorChave(resposta.json(), chave);
    assert.equal(item.tipo, 'addon');
    assert.equal(item.unit_cobrado_centavos, atual);
    assert.equal(item.subtotal_centavos, 3 * atual);
    assert.equal(item.descontos.length, 1);
  });
}

for (const [plano, atual] of [['50gb', 1770], ['100gb', 2870], ['1tb', 31900]]) {
  test(`CA1: Skybox ${plano} ×2 usa o preço do plano`, async (t) => {
    const resposta = await orcar(t, {
      ciclo: 'mensal',
      contas: { '50gb': 1 },
      addons: { skybox: { plano, quantidade: 2 } },
    });

    assert.equal(resposta.statusCode, 200);
    const item = itemPorChave(resposta.json(), 'skybox');
    assert.equal(item.plano, plano);
    assert.equal(item.subtotal_centavos, 2 * atual);
  });
}

test('CA1: Skybox com quantidade 0 não gera item; domínio extra ×2 vira avulso de 15800', async (t) => {
  const resposta = await orcar(t, {
    ciclo: 'mensal',
    contas: { '5gb': 2 },
    addons: { skybox: { plano: '1tb', quantidade: 0 }, extraDom: 2 },
  });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.equal(itemPorChave(corpo, 'skybox'), undefined);
  assert.equal(corpo.avulsos[0].subtotal_centavos, 15800);
  assert.equal(corpo.totais.avulso_centavos, 15800);
});

test('CA1: sem addons, avulsos vazio e avulso_centavos 0', async (t) => {
  const resposta = await orcar(t, { ciclo: 'mensal', contas: { '5gb': 2 } });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.equal(corpo.versao_tabela, VERSAO);
  assert.deepEqual(corpo.avulsos, []);
  assert.equal(corpo.totais.avulso_centavos, 0);
});

test('CA1: a rota não usa o banco e responde 200 com o PostgreSQL inacessível', async (t) => {
  const resposta = await orcar(t, EXEMPLO_CONTRATO, {
    sobrescritasConfig: { databaseUrl: 'postgres://127.0.0.1:1/x' },
  });

  assert.equal(resposta.statusCode, 200);
  assert.equal(resposta.json().totais.recorrente_mensal_centavos, 17030);
});

// CA2 -----------------------------------------------------------------------

const CASOS_400 = [
  ['contas.5gb negativo', { contas: { '5gb': -1 } }, [{ campo: 'contas.5gb', mensagem: 'fora do limite' }]],
  ['contas.25gb não inteiro', { contas: { '25gb': 2.5 } }, [{ campo: 'contas.25gb', mensagem: 'tipo inválido' }]],
  ['contas.25gb string', { contas: { '25gb': '2' } }, [{ campo: 'contas.25gb', mensagem: 'tipo inválido' }]],
  ['contas.50gb acima de 500', { contas: { '50gb': 501 } }, [{ campo: 'contas.50gb', mensagem: 'fora do limite' }]],
  [
    'grupoEmail acima de 500',
    { contas: { '5gb': 500, '25gb': 500, '50gb': 500 }, addons: { grupoEmail: 501 } },
    [{ campo: 'addons.grupoEmail', mensagem: 'fora do limite' }],
  ],
  [
    'skybox acima de 50',
    { contas: { '5gb': 2 }, addons: { skybox: { plano: '50gb', quantidade: 51 } } },
    [{ campo: 'addons.skybox.quantidade', mensagem: 'fora do limite' }],
  ],
  ['extraDom acima de 20', { contas: { '5gb': 2 }, addons: { extraDom: 21 } }, [{ campo: 'addons.extraDom', mensagem: 'fora do limite' }]],
  ['5gb abaixo do mínimo', { contas: { '5gb': 1 } }, [{ campo: 'contas.5gb', mensagem: 'fora do limite' }]],
  ['talk acima do total de contas', { contas: { '25gb': 3 }, addons: { talk: 4 } }, [{ campo: 'addons.talk', mensagem: 'fora do limite' }]],
  [
    'dois erros do serviço saem na ordem fixa',
    { contas: { '5gb': 1 }, addons: { talk: 2 } },
    [
      { campo: 'contas.5gb', mensagem: 'fora do limite' },
      { campo: 'addons.talk', mensagem: 'fora do limite' },
    ],
  ],
];

for (const [nome, entrada, campos] of CASOS_400) {
  test(`CA2: ${nome} → 400 validacao`, async (t) => {
    const resposta = await orcar(t, { ciclo: 'mensal', ...entrada });

    assert.equal(resposta.statusCode, 400);
    assert.deepEqual(resposta.json(), { erro: 'validacao', campos });
  });
}

const CASOS_NO_LIMITE = [
  ['grupoEmail 500 com 1500 contas', { contas: { '5gb': 500, '25gb': 500, '50gb': 500 }, addons: { grupoEmail: 500 } }],
  ['contas.5gb 500', { contas: { '5gb': 500 } }],
  ['contas.5gb 2 (mínimo)', { contas: { '5gb': 2 } }],
  ['backup90 igual ao total de contas', { contas: { '5gb': 2, '50gb': 1 }, addons: { backup90: 3 } }],
  ['skybox 50', { contas: { '5gb': 2 }, addons: { skybox: { plano: '50gb', quantidade: 50 } } }],
  ['extraDom 20', { contas: { '5gb': 2 }, addons: { extraDom: 20 } }],
];

for (const [nome, entrada] of CASOS_NO_LIMITE) {
  test(`CA2: no limite, ${nome} → 200`, async (t) => {
    const resposta = await orcar(t, { ciclo: 'mensal', ...entrada });

    assert.equal(resposta.statusCode, 200, resposta.body);
  });
}

// CA3 -----------------------------------------------------------------------

const CASOS_MALFORMADOS = [
  ['contas.10gb', { ciclo: 'mensal', contas: { '5gb': 2, '10gb': 1 } }, [{ campo: 'contas.10gb', mensagem: 'campo não permitido' }]],
  ['addons.antivirus', { ciclo: 'mensal', contas: { '5gb': 2 }, addons: { antivirus: 1 } }, [{ campo: 'addons.antivirus', mensagem: 'campo não permitido' }]],
  ['total_centavos na raiz', { ciclo: 'mensal', contas: { '5gb': 2 }, total_centavos: 1 }, [{ campo: 'total_centavos', mensagem: 'campo não permitido' }]],
  ['addons.talk_preco', { ciclo: 'mensal', contas: { '5gb': 2 }, addons: { talk_preco: 1 } }, [{ campo: 'addons.talk_preco', mensagem: 'campo não permitido' }]],
  ['contas.unit_centavos', { ciclo: 'mensal', contas: { '5gb': 2, unit_centavos: 1 } }, [{ campo: 'contas.unit_centavos', mensagem: 'campo não permitido' }]],
  ['ciclo ausente', { contas: { '5gb': 2 } }, [{ campo: 'ciclo', mensagem: 'obrigatório' }]],
  [
    'skybox sem plano',
    { ciclo: 'mensal', contas: { '5gb': 2 }, addons: { skybox: { quantidade: 1 } } },
    [{ campo: 'addons.skybox.plano', mensagem: 'obrigatório' }],
  ],
  ['ciclo fora do enum', { ciclo: 'semanal', contas: { '5gb': 2 } }, [{ campo: 'ciclo', mensagem: 'valor inválido' }]],
  [
    'plano Skybox inexistente',
    { ciclo: 'mensal', contas: { '5gb': 2 }, addons: { skybox: { plano: '2tb', quantidade: 1 } } },
    [{ campo: 'addons.skybox.plano', mensagem: 'valor inválido' }],
  ],
  ['contas vazio', { ciclo: 'mensal', contas: {} }, [{ campo: 'contas', mensagem: 'fora do limite' }]],
  [
    'zero contas com add-ons',
    { ciclo: 'mensal', contas: { '5gb': 0, '25gb': 0, '50gb': 0 }, addons: { talk: 1, extraDom: 1 } },
    [{ campo: 'contas', mensagem: 'fora do limite' }],
  ],
];

for (const [nome, entrada, campos] of CASOS_MALFORMADOS) {
  test(`CA3: ${nome} → 400 validacao`, async (t) => {
    const resposta = await orcar(t, entrada);

    assert.equal(resposta.statusCode, 400);
    assert.deepEqual(resposta.json(), { erro: 'validacao', campos });
  });
}

test('CA3: 100 chaves desconhecidas em addons → campos com exatamente 20 itens', async (t) => {
  const addons = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`chave${i}`, 1]));
  const resposta = await orcar(t, { ciclo: 'mensal', contas: { '5gb': 2 }, addons });

  assert.equal(resposta.statusCode, 400);
  const corpo = resposta.json();
  assert.equal(corpo.erro, 'validacao');
  assert.equal(corpo.campos.length, 20);
});

test('CA3: chave desconhecida com 300 caracteres → campo com no máximo 100 caracteres', async (t) => {
  const addons = { ['x'.repeat(300)]: 1 };
  const resposta = await orcar(t, { ciclo: 'mensal', contas: { '5gb': 2 }, addons });

  assert.equal(resposta.statusCode, 400);
  const { campos } = resposta.json();
  assert.equal(campos.length, 1);
  assert.ok(campos[0].campo.length <= 100, `campo com ${campos[0].campo.length} caracteres`);
  assert.equal(campos[0].mensagem, 'campo não permitido');
});

test('CA3: JSON inválido → 400 json_invalido', async (t) => {
  const { app, fechar } = await construirAppTeste({ comBanco: false });
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/orcamento',
    headers: { 'content-type': 'application/json' },
    payload: '{ "ciclo": ',
  });

  assert.equal(resposta.statusCode, 400);
  assert.deepEqual(resposta.json(), { erro: 'json_invalido' });
});

// CA6 -----------------------------------------------------------------------

test('CA6: POST com origem fora de CORS_ORIGENS não recebe access-control-allow-origin', async (t) => {
  const { app, fechar } = await construirAppTeste({ comBanco: false });
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/orcamento',
    headers: { origin: 'https://outra-origem.example' },
    payload: { ciclo: 'mensal', contas: { '5gb': 2 } },
  });

  assert.equal(resposta.headers['access-control-allow-origin'], undefined);
});

test('CA6: POST com origem permitida recebe allow-origin, sem allow-credentials', async (t) => {
  const { app, fechar } = await construirAppTeste({ comBanco: false });
  t.after(fechar);

  const resposta = await app.inject({
    method: 'POST',
    url: '/api/orcamento',
    headers: { origin: ORIGEM_PERMITIDA },
    payload: { ciclo: 'mensal', contas: { '5gb': 2 } },
  });

  assert.equal(resposta.statusCode, 200);
  assert.equal(resposta.headers['access-control-allow-origin'], ORIGEM_PERMITIDA);
  assert.equal(resposta.headers['access-control-allow-credentials'], undefined);
});

test('CA6: preflight de POST /api/orcamento responde 204 com GET, POST e Content-Type', async (t) => {
  const { app, fechar } = await construirAppTeste({ comBanco: false });
  t.after(fechar);

  const resposta = await app.inject({
    method: 'OPTIONS',
    url: '/api/orcamento',
    headers: {
      origin: ORIGEM_PERMITIDA,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });

  assert.equal(resposta.statusCode, 204);
  assert.equal(resposta.headers['access-control-allow-origin'], ORIGEM_PERMITIDA);
  assert.equal(resposta.headers['access-control-allow-methods'], 'GET, POST');
  assert.equal(resposta.headers['access-control-allow-headers'], 'Content-Type');
});

// CA7 -----------------------------------------------------------------------

test('CA7: corpo JSON de 70 000 bytes → 413 corpo_muito_grande, sem stack', async (t) => {
  const { app, fechar } = await construirAppTeste({ comBanco: false });
  t.after(fechar);

  const payload = JSON.stringify({ ciclo: 'mensal', contas: { '5gb': 2 }, x: 'a'.repeat(70000) });
  const resposta = await app.inject({
    method: 'POST',
    url: '/api/orcamento',
    headers: { 'content-type': 'application/json' },
    payload,
  });

  assert.equal(resposta.statusCode, 413);
  assert.deepEqual(resposta.json(), { erro: 'corpo_muito_grande' });
  for (const trecho of ['stack', 'FST_', '    at ']) {
    assert.ok(!resposta.body.includes(trecho), `corpo não deveria conter "${trecho}": ${resposta.body}`);
  }
});

// CIT-183 -------------------------------------------------------------------

const B = { ciclo: 'mensal', contas: { '5gb': 2 } };
const DOMINIO_PRINCIPAL = { tipo: 'dominio_principal', quantidade: 1, periodo: 'ano', unit_centavos: 7900, subtotal_centavos: 7900 };
const DOMINIO_EXTRA_2 = { tipo: 'dominio_extra', quantidade: 2, periodo: 'ano', unit_centavos: 7900, subtotal_centavos: 15800 };

test('CIT-183 CA1: domínio novo responde 200 com o avulso dominio_principal de 7900', async (t) => {
  const resposta = await orcar(t, { ...B, dominio: { tipo: 'novo' } });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.deepEqual(corpo.avulsos, [DOMINIO_PRINCIPAL]);
  assert.equal(corpo.totais.avulso_centavos, 7900);
});

test('CIT-183 CA1: domínio novo com extraDom ×2 põe o principal antes do extra e soma 23700', async (t) => {
  const resposta = await orcar(t, { ...B, addons: { extraDom: 2 }, dominio: { tipo: 'novo' } });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.deepEqual(corpo.avulsos.map((a) => a.tipo), ['dominio_principal', 'dominio_extra']);
  assert.deepEqual(corpo.avulsos, [DOMINIO_PRINCIPAL, DOMINIO_EXTRA_2]);
  assert.equal(corpo.totais.avulso_centavos, 23700);
});

test('CIT-183 CA1: domínio novo só muda avulsos e avulso_centavos; itens e totais recorrentes ficam iguais', async (t) => {
  const com = (await orcar(t, { ...B, dominio: { tipo: 'novo' } })).json();
  const sem = (await orcar(t, B)).json();

  assert.deepEqual(com.itens, sem.itens);
  const { avulso_centavos: _a, ...totaisCom } = com.totais;
  const { avulso_centavos: _b, ...totaisSem } = sem.totais;
  assert.deepEqual(totaisCom, totaisSem);
});

test('CIT-183 CA1: com ciclo anual o domínio principal continua 7900, sem desconto anual', async (t) => {
  const resposta = await orcar(t, { ciclo: 'anual', contas: { '5gb': 2 }, dominio: { tipo: 'novo' } });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.equal(corpo.avulsos[0].tipo, 'dominio_principal');
  assert.equal(corpo.avulsos[0].unit_centavos, 7900);
  assert.equal(corpo.avulsos[0].subtotal_centavos, 7900);
});

test('CIT-183 CA1: o schema de resposta exportado lista dominio_principal e dominio_extra no enum de avulsos.tipo', async () => {
  const { respostaOrcamento } = await import('../src/precos/rotas.js');

  assert.deepEqual(respostaOrcamento.properties.avulsos.items.properties.tipo.enum, ['dominio_principal', 'dominio_extra']);
});

test('CIT-183 CA2: domínio existente responde 200 sem avulsos e com avulso_centavos 0', async (t) => {
  const resposta = await orcar(t, { ...B, dominio: { tipo: 'existente' } });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.deepEqual(corpo.avulsos, []);
  assert.equal(corpo.totais.avulso_centavos, 0);
});

test('CIT-183 CA2: domínio existente com extraDom ×1 cobra só o extra, sem dominio_principal', async (t) => {
  const resposta = await orcar(t, { ...B, addons: { extraDom: 1 }, dominio: { tipo: 'existente' } });

  assert.equal(resposta.statusCode, 200);
  const corpo = resposta.json();
  assert.equal(corpo.avulsos.length, 1);
  assert.equal(corpo.avulsos[0].tipo, 'dominio_extra');
  assert.equal(corpo.avulsos[0].subtotal_centavos, 7900);
  assert.equal(corpo.avulsos.some((a) => a.tipo === 'dominio_principal'), false);
});

const CORPOS_COMPAT = [
  ['B', B],
  ['EXEMPLO_CONTRATO', EXEMPLO_CONTRATO],
];

for (const [nome, corpo] of CORPOS_COMPAT) {
  test(`CIT-183 CA3: ${nome} sem dominio não tem dominio_principal e mantém a versão da tabela`, async (t) => {
    const resposta = await orcar(t, corpo);

    assert.equal(resposta.statusCode, 200);
    const json = resposta.json();
    assert.equal(json.avulsos.some((a) => a.tipo === 'dominio_principal'), false);
    assert.equal(json.versao_tabela, '2026-11-07.1');
  });

  test(`CIT-183 CA3: ${nome} com dominio existente responde igual ao mesmo corpo sem dominio`, async (t) => {
    const sem = await orcar(t, corpo);
    const com = await orcar(t, { ...corpo, dominio: { tipo: 'existente' } });

    assert.equal(com.statusCode, 200);
    assert.deepEqual(com.json(), sem.json());
  });
}

const CASOS_DOMINIO_400 = [
  ['tipo fora do enum', { dominio: { tipo: 'transferencia' } }, [{ campo: 'dominio.tipo', mensagem: 'valor inválido' }]],
  ['dominio vazio', { dominio: {} }, [{ campo: 'dominio.tipo', mensagem: 'obrigatório' }]],
  ['campo nome extra', { dominio: { tipo: 'novo', nome: 'exemplo.com.br' } }, [{ campo: 'dominio.nome', mensagem: 'campo não permitido' }]],
  ['campo unit_centavos extra', { dominio: { tipo: 'novo', unit_centavos: 1 } }, [{ campo: 'dominio.unit_centavos', mensagem: 'campo não permitido' }]],
  [
    'tipo numérico',
    { dominio: { tipo: 1 } },
    [
      { campo: 'dominio.tipo', mensagem: 'tipo inválido' },
      { campo: 'dominio.tipo', mensagem: 'valor inválido' },
    ],
  ],
  ['dominio string', { dominio: 'novo' }, [{ campo: 'dominio', mensagem: 'tipo inválido' }]],
  ['dominio null', { dominio: null }, [{ campo: 'dominio', mensagem: 'tipo inválido' }]],
  ['dominio array', { dominio: [] }, [{ campo: 'dominio', mensagem: 'tipo inválido' }]],
  ['zero contas com domínio novo', { contas: {}, dominio: { tipo: 'novo' } }, [{ campo: 'contas', mensagem: 'fora do limite' }]],
];

for (const [nome, entrada, campos] of CASOS_DOMINIO_400) {
  test(`CIT-183 CA4: ${nome} → 400 validacao`, async (t) => {
    const resposta = await orcar(t, { ciclo: 'mensal', contas: { '5gb': 2 }, ...entrada });

    assert.equal(resposta.statusCode, 400);
    assert.deepEqual(resposta.json(), { erro: 'validacao', campos });
  });
}
