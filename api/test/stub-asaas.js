// Stub HTTP local da API v3 do Asaas (CIT-61), só para os testes: escuta em 127.0.0.1
// (o `sem-rede.js` libera o loopback). Registra cada chamada, mantém o estado dos clientes
// e das assinaturas criados e deixa configurar, por rota, status, corpo, atraso, ausência
// de resposta e "aceita e responde tarde". Todo corpo de erro leva o marcador
// `CORPO-DO-STUB`, para provar que nenhum texto do Asaas chega a log ou resposta.
import http from 'node:http';

export const MARCADOR_CORPO = 'CORPO-DO-STUB';

function rotuloDaRota(metodo, caminho) {
  if (/^\/payments\/[^/]+$/.test(caminho)) return `${metodo} /payments/{id}`;
  if (/^\/subscriptions\/[^/]+\/payments$/.test(caminho)) return `${metodo} /subscriptions/{id}/payments`;
  if (/^\/subscriptions\/[^/]+$/.test(caminho)) return `${metodo} /subscriptions/{id}`;
  return `${metodo} ${caminho}`;
}

function lerCorpo(request) {
  return new Promise((resolve) => {
    const pedacos = [];
    request.on('data', (pedaco) => pedacos.push(pedaco));
    request.on('end', () => {
      const texto = Buffer.concat(pedacos).toString('utf8');
      try {
        resolve(texto ? JSON.parse(texto) : undefined);
      } catch {
        resolve(texto);
      }
    });
    request.on('error', () => resolve(undefined));
  });
}

/**
 * Comportamento de uma rota (objeto ou função `({ n, corpo, query }) => objeto | undefined`,
 * onde `n` é o nº da chamada àquela rota, a partir de 1):
 * - `status` (+ `corpo`): responde isso sem aplicar efeito; erro sem `corpo` leva o marcador.
 * - `atrasoMs`: espera antes de processar e responder.
 * - `semResposta`: aceita a conexão e nunca responde (o cliente estoura o timeout).
 * - `criaESemResposta`: aplica o efeito (cria o recurso) e nunca responde.
 * - `respostaTardiaMs`: aplica o efeito já e responde só depois ("aceita e responde tarde").
 * - `redirecionarPara`: responde 302.
 */
export async function criarStubAsaas() {
  const chamadas = [];
  const comportamentos = new Map();
  const contagemPorRota = new Map();
  const timers = new Set();
  let clientes = [];
  let assinaturas = [];
  let pagamentos = [];
  let sequencia = 0;
  let esperas = [];

  function esperar(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  }

  function responder(res, status, corpo) {
    if (res.destroyed || res.writableEnded) return;
    const texto = corpo === undefined ? '' : JSON.stringify(corpo);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(texto);
  }

  // Efeito padrão de cada rota (o Asaas "funcionando").
  function efeito(metodo, caminho, query, corpo) {
    if (metodo === 'GET' && caminho === '/customers') {
      return { status: 200, corpo: { data: clientes.filter((c) => c.cpfCnpj === query.cpfCnpj) } };
    }
    if (metodo === 'POST' && caminho === '/customers') {
      sequencia += 1;
      const cliente = {
        id: `cus_stub_${sequencia}`,
        cpfCnpj: corpo?.cpfCnpj,
        name: corpo?.name,
        email: corpo?.email,
        externalReference: corpo?.externalReference
      };
      clientes.push(cliente);
      return { status: 200, corpo: { id: cliente.id } };
    }
    if (metodo === 'GET' && caminho === '/subscriptions') {
      return {
        status: 200,
        corpo: { data: assinaturas.filter((a) => a.externalReference === query.externalReference) }
      };
    }
    if (metodo === 'POST' && caminho === '/subscriptions') {
      sequencia += 1;
      const assinatura = {
        id: `sub_stub_${sequencia}`,
        externalReference: corpo?.externalReference,
        numero: sequencia,
        dateCreated: new Date(Date.UTC(2026, 0, 1, 0, 0, sequencia)).toISOString()
      };
      assinaturas.push(assinatura);
      return { status: 200, corpo: { id: assinatura.id } };
    }
    const payments = caminho.match(/^\/subscriptions\/([^/]+)\/payments$/);
    if (metodo === 'GET' && payments) {
      const assinatura = assinaturas.find((a) => a.id === payments[1]);
      const urlFatura = `https://stub.test/f/${assinatura?.numero ?? 0}`;
      return { status: 200, corpo: { data: assinatura ? [{ invoiceUrl: urlFatura }] : [] } };
    }
    const pagamento = caminho.match(/^\/payments\/([^/]+)$/);
    if (metodo === 'GET' && pagamento) {
      const achado = pagamentos.find((p) => p.id === pagamento[1]);
      return achado
        ? { status: 200, corpo: achado }
        : { status: 404, corpo: { errors: [{ description: MARCADOR_CORPO }] } };
    }
    const remocao = caminho.match(/^\/subscriptions\/([^/]+)$/);
    if (metodo === 'DELETE' && remocao) {
      assinaturas = assinaturas.filter((a) => a.id !== remocao[1]);
      return { status: 200, corpo: { deleted: true, id: remocao[1] } };
    }
    return { status: 404, corpo: { errors: [{ description: MARCADOR_CORPO }] } };
  }

  const servidor = http.createServer(async (request, res) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const metodo = request.method;
    const caminho = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    const corpo = await lerCorpo(request);
    const rotulo = rotuloDaRota(metodo, caminho);
    const n = (contagemPorRota.get(rotulo) ?? 0) + 1;
    contagemPorRota.set(rotulo, n);
    chamadas.push({ rotulo, metodo, caminho, query, cabecalhos: request.headers, corpo });

    for (const espera of esperas.filter((e) => e.rotulo === rotulo && e.n === n)) espera.resolver();
    esperas = esperas.filter((e) => !(e.rotulo === rotulo && e.n === n));

    const definido = comportamentos.get(rotulo);
    const comportamento = (typeof definido === 'function' ? definido({ n, corpo, query }) : definido) ?? {};

    if (comportamento.semResposta) return;
    if (comportamento.criaESemResposta) {
      // Aplica o efeito (cria o recurso) e nunca responde: o cliente estoura o timeout.
      efeito(metodo, caminho, query, corpo);
      return;
    }
    if (comportamento.atrasoMs) await esperar(comportamento.atrasoMs);
    if (comportamento.redirecionarPara) {
      res.writeHead(302, { Location: comportamento.redirecionarPara });
      res.end();
      return;
    }
    if (comportamento.status !== undefined && comportamento.status >= 400) {
      responder(res, comportamento.status, comportamento.corpo ?? { errors: [{ description: MARCADOR_CORPO }] });
      return;
    }
    const padrao = efeito(metodo, caminho, query, corpo);
    const resposta = comportamento.status === undefined
      ? padrao
      : { status: comportamento.status, corpo: comportamento.corpo ?? padrao.corpo };
    if (comportamento.corpo !== undefined && comportamento.status === undefined) resposta.corpo = comportamento.corpo;
    if (comportamento.respostaTardiaMs) await esperar(comportamento.respostaTardiaMs);
    responder(res, resposta.status, resposta.corpo);
  });

  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const { port } = servidor.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    chamadas,
    /** Define o comportamento de uma rota, ex.: `definir('POST /subscriptions', { status: 500 })`. */
    definir(rotulo, comportamento) {
      comportamentos.set(rotulo, comportamento);
    },
    /** Rótulos das chamadas recebidas, na ordem (ex.: `GET /customers`). */
    rotulos() {
      return chamadas.map((c) => c.rotulo);
    },
    chamadasDe(rotulo) {
      return chamadas.filter((c) => c.rotulo === rotulo);
    },
    /** Cliente já existente no Asaas (para o `GET /customers`). */
    semearCliente({ id, documento, nome, email, deleted }) {
      clientes.push({
        id,
        cpfCnpj: documento,
        ...(nome === undefined ? {} : { name: nome }),
        ...(email === undefined ? {} : { email }),
        ...(deleted ? { deleted: true } : {})
      });
    },
    /** Assinatura já existente no Asaas (para o `GET /subscriptions`). */
    semearAssinatura({ id, externalReference, deleted, dateCreated }) {
      sequencia += 1;
      assinaturas.push({
        id,
        externalReference,
        numero: sequencia,
        ...(dateCreated ? { dateCreated } : {}),
        ...(deleted ? { deleted: true } : {})
      });
    },
    /** Pagamento já existente no Asaas (para o `GET /payments/{id}`); `value` em reais. */
    semearPagamento(pagamento) {
      pagamentos = pagamentos.filter((p) => p.id !== pagamento.id);
      pagamentos.push(pagamento);
    },
    /** Resolve quando a `n`-ésima chamada à rota chegar ao stub (sem polling). */
    esperarChamada(rotulo, n = 1) {
      if ((contagemPorRota.get(rotulo) ?? 0) >= n) return Promise.resolve();
      return new Promise((resolver) => esperas.push({ rotulo, n, resolver }));
    },
    assinaturasVivas() {
      return assinaturas.filter((a) => a.deleted !== true).map((a) => a.id);
    },
    /** Esquece chamadas, comportamentos e estado, entre cenários. */
    limpar() {
      chamadas.length = 0;
      comportamentos.clear();
      contagemPorRota.clear();
      esperas = [];
      clientes = [];
      assinaturas = [];
      pagamentos = [];
    },
    async fechar() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      servidor.closeAllConnections();
      await new Promise((resolve) => servidor.close(resolve));
    }
  };
}
