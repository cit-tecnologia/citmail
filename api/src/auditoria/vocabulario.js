// Vocabulário fechado da trilha de auditoria (ADR 0013, item 7; CIT-58). As quatro
// primeiras listas são as mesmas dos CHECK da migração `auditoria`: mudou aqui, muda
// lá (nova migração) no mesmo PR.

export const ACOES = Object.freeze([
  'login', 'login_falhou', 'conta_bloqueada', 'caixa_criada', 'caixa_excluida', 'senha_trocada',
  'cadastro_alterado', 'assinatura_cancelada', 'dados_excluidos', 'conta_suspensa', 'conta_reativada',
  'dominio_registrado_manualmente'
])

export const AUTORES = Object.freeze(['cliente', 'sistema', 'equipe'])

export const ALVOS = Object.freeze(['conta', 'caixa', 'cliente', 'pedido', 'assinatura', 'dominio'])

export const RESULTADOS = Object.freeze(['sucesso', 'falha'])

// Chaves recusadas em `detalhes` por igualdade, sem diferenciar maiúsculas. Cópia em
// minúsculas de `camposSensiveis` (`log.js`), sem importá-la: chave nova lá não pode
// virar erro aqui em produção. Um teste confere que toda chave do log é recusada.
// `ip` e variações de IP (`ip_origem`, `x-forwarded-for`...) a mais, só por igualdade (`tipo` e `zip` passam): IP fora da coluna escaparia da pseudonimização.
export const CHAVES_PROIBIDAS = Object.freeze([
  'senha', 'token', 'email', 'telefone', 'nome', 'cpf', 'cnpj', 'cpfcnpj', 'documento', 'razaosocial',
  'nascimento', 'datanascimento', 'cep', 'endereco', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade',
  'localidade',
  'password', 'authorization', 'accesstoken', 'access_token', 'refreshtoken', 'apikey',
  'name', 'phone', 'mobilephone', 'company', 'postalcode', 'address', 'addressnumber', 'complement', 'province',
  'cityname', 'additionalemails', 'municipalinscription', 'stateinscription', 'creditcard', 'creditcardtoken',
  'ip', 'ip_origem', 'iporigem', 'ipcliente', 'ip_cliente', 'remoteaddress', 'remote_addr', 'x-forwarded-for',
  'xforwardedfor', 'forwarded', 'x-real-ip', 'ipaceite', 'ip_aceite'
])

// Trechos recusados em qualquer posição da chave (pega novaSenha, refresh_token, x-api-key,
// email_contato, cpf_titular...).
export const TRECHOS_PROIBIDOS = Object.freeze([
  'senha', 'password', 'token', 'secret', 'authorization', 'cookie', 'apikey', 'api_key',
  'email', 'cpf', 'cnpj', 'telefone'
])
