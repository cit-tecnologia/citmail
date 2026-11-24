// Stub SMTP dos testes do e-mail transacional (CIT-65): servidor `node:net` em 127.0.0.1,
// porta efêmera, sem rede externa. Fala EHLO, AUTH PLAIN e LOGIN (aceita qualquer credencial
// fictícia), MAIL, RCPT, DATA, RSET, NOOP e QUIT; registra o envelope e o DATA bruto (sem
// decodificar quoted-printable nem base64: os dados de teste são ASCII) e conta conexões.
//
// Roteiro: `rcpt` é a lista de respostas aos comandos RCPT, na ordem em que chegam (ao
// esgotar, a última se repete; vazia, aceita com 250). Resposta diferente de `250` é
// 4xx/5xx e ECOA O ENDEREÇO (`451 4.7.1 <fulano@exemplo.test> tente depois`), como servidores
// reais fazem: é o que o teste de log sem dado pessoal precisa provocar. `fecharNaConexao`
// lista números de conexão (1, 2...) derrubados logo ao aceitar.
import net from 'node:net';

const LOGIN_USUARIO = 'VXNlcm5hbWU6'; // base64 de "Username:"
const LOGIN_SENHA = 'UGFzc3dvcmQ6'; // base64 de "Password:"

function respostaDeRcpt(codigo, endereco) {
  if (codigo === '250') return '250 2.1.5 ok';
  const classe = codigo.startsWith('5') ? '5.1.1' : '4.7.1';
  return `${codigo} ${classe} <${endereco}> ${codigo.startsWith('5') ? 'rejeitado' : 'tente depois'}`;
}

export async function criarStubSmtp({ rcpt = [], fecharNaConexao = [], porta: portaFixa = 0 } = {}) {
  const estado = {
    rcpt: [...rcpt],
    fecharNaConexao: new Set(fecharNaConexao),
    conexoes: 0,
    comandosRcpt: 0,
    mensagens: [],
    sockets: new Set(),
    esperas: []
  };
  let servidor;
  let porta = portaFixa;

  function aoConectar(socket) {
    estado.conexoes += 1;
    estado.sockets.add(socket);
    socket.on('close', () => estado.sockets.delete(socket));
    socket.on('error', () => {});
    if (estado.fecharNaConexao.has(estado.conexoes)) {
      socket.destroy();
      return;
    }
    let atual = { mailFrom: null, rcptTo: [], data: '' };
    let emData = false;
    let aguardandoLogin = null;
    let buffer = '';

    function responder(linha) {
      if (!socket.destroyed) socket.write(`${linha}\r\n`);
    }

    function tratar(linha) {
      if (emData) {
        if (linha === '.') {
          emData = false;
          estado.mensagens.push(atual);
          for (const espera of estado.esperas.filter((e) => estado.mensagens.length >= e.quantidade)) espera.resolver();
          estado.esperas = estado.esperas.filter((e) => estado.mensagens.length < e.quantidade);
          atual = { mailFrom: null, rcptTo: [], data: '' };
          responder('250 2.0.0 aceito');
        } else {
          atual.data += `${linha.startsWith('..') ? linha.slice(1) : linha}\r\n`;
        }
        return;
      }
      if (aguardandoLogin) {
        aguardandoLogin = aguardandoLogin === 'usuario' ? 'senha' : null;
        responder(aguardandoLogin === 'senha' ? `334 ${LOGIN_SENHA}` : '235 2.7.0 ok');
        return;
      }
      const comando = linha.toUpperCase();
      if (comando.startsWith('EHLO') || comando.startsWith('HELO')) {
        responder('250-stub');
        responder('250 AUTH PLAIN LOGIN');
      } else if (comando.startsWith('AUTH PLAIN')) {
        responder('235 2.7.0 ok');
      } else if (comando.startsWith('AUTH LOGIN')) {
        aguardandoLogin = 'usuario';
        responder(`334 ${LOGIN_USUARIO}`);
      } else if (comando.startsWith('MAIL FROM:')) {
        atual.mailFrom = linha.slice('MAIL FROM:'.length).trim().replace(/^<|>.*$/g, '');
        responder('250 2.1.0 ok');
      } else if (comando.startsWith('RCPT TO:')) {
        const endereco = linha.slice('RCPT TO:'.length).trim().replace(/^<|>.*$/g, '');
        const indice = Math.min(estado.comandosRcpt, estado.rcpt.length - 1);
        const codigo = estado.rcpt.length === 0 ? '250' : estado.rcpt[indice];
        estado.comandosRcpt += 1;
        if (codigo === '250') atual.rcptTo.push(endereco);
        responder(respostaDeRcpt(codigo, endereco));
      } else if (comando === 'DATA') {
        emData = true;
        responder('354 envie');
      } else if (comando === 'QUIT') {
        socket.end('221 2.0.0 tchau\r\n');
      } else if (comando === 'RSET' || comando === 'NOOP') {
        atual = { mailFrom: null, rcptTo: [], data: '' };
        responder('250 2.0.0 ok');
      } else {
        responder('502 5.5.2 comando desconhecido');
      }
    }

    socket.on('data', (pedaco) => {
      buffer += pedaco.toString('utf8');
      let fim;
      while ((fim = buffer.indexOf('\r\n')) >= 0) {
        const linha = buffer.slice(0, fim);
        buffer = buffer.slice(fim + 2);
        tratar(linha);
      }
    });
    responder('220 stub ESMTP');
  }

  async function iniciar() {
    servidor = net.createServer(aoConectar);
    await new Promise((resolver, rejeitar) => {
      servidor.once('error', rejeitar);
      servidor.listen(porta, '127.0.0.1', resolver);
    });
    porta = servidor.address().port;
  }

  async function parar() {
    if (!servidor) return;
    const alvo = servidor;
    servidor = undefined;
    for (const socket of estado.sockets) socket.destroy();
    await new Promise((resolver) => alvo.close(resolver));
  }

  await iniciar();

  return {
    host: '127.0.0.1',
    get porta() {
      return porta;
    },
    get mensagens() {
      return estado.mensagens;
    },
    get conexoes() {
      return estado.conexoes;
    },
    /** Resolve quando o stub já aceitou `quantidade` mensagens (sem polling). */
    aguardarMensagens(quantidade) {
      if (estado.mensagens.length >= quantidade) return Promise.resolve();
      return new Promise((resolver) => estado.esperas.push({ quantidade, resolver }));
    },
    /** Troca o roteiro de RCPT e zera o contador de comandos. */
    definirRcpt(respostas) {
      estado.rcpt = [...respostas];
      estado.comandosRcpt = 0;
    },
    /** Porta fechada na mesma porta (conexão recusada); `iniciar` reabre nela. */
    parar,
    iniciar,
    fechar: parar
  };
}
