// Transporte do e-mail transacional (ADR 0010; CIT-65). `smtp` usa o `nodemailer`
// (Skymail em produção); `desligado` não abre conexão e o job grava `nao_enviado`.
// Sem log nem debug do `nodemailer`: ambos repetiriam endereço, assunto e corpo.
import nodemailer from 'nodemailer'

/**
 * Cria o transporte a partir da configuração do worker (`carregarConfigWorker`).
 * Devolve `{ ligado, enviar(mensagem) }`; `enviar` devolve o `info` do `nodemailer`
 * (`messageId`, `accepted`...). Desligado, `ligado` é false e `enviar` lança.
 */
export function criarTransporte(config) {
  if (config.emailTransporte !== 'smtp') {
    return {
      ligado: false,
      async enviar() {
        throw new Error('transporte de e-mail desligado')
      },
      close() {}
    }
  }
  const transporte = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPorta,
    secure: config.smtpPorta === 465,
    requireTLS: config.smtpRequireTls === true,
    auth: { user: config.smtpUsuario, pass: config.smtpSenha },
    connectionTimeout: config.smtpTimeoutMs,
    greetingTimeout: config.smtpTimeoutMs,
    socketTimeout: config.smtpTimeoutMs,
    // A mensagem nunca lê arquivo nem URL (anexo ou imagem): só o texto renderizado.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false
  })
  return {
    ligado: true,
    enviar: (mensagem) => transporte.sendMail(mensagem),
    close: () => transporte.close()
  }
}
