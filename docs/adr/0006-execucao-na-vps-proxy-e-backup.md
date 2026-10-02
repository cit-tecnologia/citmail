# 0006. Execução na VPS, proxy reverso com HTTPS e backup

Status: aceito
Data: 2026-09-25

## Contexto

Decidido pelo responsável em 2026-09-25: API e PostgreSQL na mesma VPS da CIT (`<host-da-vps>`), com o backup fora dela. Falta decidir como os processos rodam, como o HTTPS é servido e como o backup é feito. O SLA é 99,5% de disponibilidade mensal (briefing 6.4), e uma única VPS concentra API, banco e — pela decisão do ADR 0005 — também o Redis.

**Placeholders obrigatórios:** este ADR e qualquer outro documento em `docs/` nunca citam host, IP, porta ou usuário reais da VPS. Usar sempre `<host-da-vps>`, `<porta-ssh>`, `<usuario-de-deploy>`, `<usuario-de-servico>` (ver regra em `docs/adr/README.md`).

## Opções consideradas

### Opção 1: Processos `systemd` + Caddy
API e workers da fila como serviços `systemd`, rodando com usuário próprio sem login; proxy reverso Caddy na frente, com HTTPS automático via Let's Encrypt.

### Opção 2: Docker Compose
API, banco, Redis e proxy como contêineres orquestrados por `docker-compose.yml` na VPS.

### Opção 3: PM2 + Nginx + certbot
Processos Node.js gerenciados pelo PM2, atrás de Nginx com certificado emitido e renovado pelo certbot.

## Decisão

**Decidido pelo responsável em 2026-09-25:** API e PostgreSQL na mesma VPS; backup fora dela.

**Proposto:**

1. **Processos:** serviços `systemd` (API e worker da fila; o worker sobe com `npm run worker`, CIT-56), com usuário de serviço próprio, sem login e sem shell (`<usuario-de-servico>`), diferente do usuário de deploy. O usuário de deploy só publica os arquivos e reinicia o serviço.
2. **Endurecimento da unidade:** `NoNewPrivileges=true`, `ProtectSystem=strict`, `PrivateTmp=true`, `WorkingDirectory` fixo e caminho absoluto no `ExecStart`.
3. **Proxy:** Caddy com HTTPS automático. A API escuta só no loopback, atrás do Caddy (o `trustProxy` do ADR 0003 confia só nele).
4. **PostgreSQL e Redis** só na interface de loopback, sem porta aberta no firewall.
5. **Redis:** uma instância para fila e sessão (ADRs 0005 e 0008), com `appendonly yes` (AOF, para não perder jobs num reinício) e `maxmemory-policy noeviction` (exigência do BullMQ: sem isso, o Redis pode descartar chaves de jobs). Com `noeviction`, memória cheia vira erro de escrita, coberto pelo alerta de infraestrutura (ADR 0011).
6. **Homologação:** se rodar na mesma VPS da produção, cada ambiente tem banco e usuário de banco próprios, Redis próprio (ou número de banco/prefixo e senha distintos), arquivo de ambiente e credenciais separados. Homologação nunca lê dados nem segredos da produção e não recebe dados reais de clientes.
7. **Backup:**
   - `pg_dump` diário, cifrado com criptografia assimétrica (ex.: `age`): a VPS só tem a chave pública; a chave privada fica fora da VPS, no gerenciador de senhas do time.
   - Envio a um armazenamento de objetos externo, com credencial só de gravação (sem leitura nem exclusão).
   - Retenção de 30 dias com bloqueio de objeto (imutabilidade) durante a retenção: nem a credencial da VPS apaga ou sobrescreve um backup.
   - Teste de restauração periódico (proposta: mensal) é critério da E2-H7.

Exemplo ilustrativo (unidade `systemd`):

```ini
[Unit]
Description=CITMail API
After=network.target postgresql.service redis-server.service

[Service]
User=<usuario-de-servico>
WorkingDirectory=/srv/citmail/api
ExecStart=/usr/bin/node /srv/citmail/api/src/index.js
EnvironmentFile=/etc/citmail/api.env
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## Justificativa

- **`systemd` sem dependência extra:** a VPS já roda Linux com `systemd`; não é preciso instalar e manter Docker ou PM2 como camada adicional. Um serviço por processo (API, worker da fila) com `Restart=on-failure` cobre reinício automático sem orquestrador.
- **Usuário de serviço separado:** uma falha na API não dá acesso às permissões de deploy, e o usuário de deploy não lê os segredos da API.
- **Caddy com HTTPS automático:** Caddy renova certificado Let's Encrypt sozinho, sem o par certbot + configuração manual de renovação do Nginx, reduzindo um ponto de falha operacional (certificado vencido).
- **Interface local para banco e fila:** PostgreSQL e Redis expostos só no loopback eliminam a superfície de ataque de uma porta de banco aberta à internet, sem depender de regra de firewall como única proteção (defesa em profundidade, ver também ADR 0013).
- **Backup fora da VPS, cifrado e imutável:** um `pg_dump` que fica na mesma VPS não sobrevive à perda da própria VPS. Com cifra assimétrica, quem invadir a VPS não lê backups antigos; com credencial só de gravação e bloqueio de objeto, não os apaga. Docker Compose ou PM2 + Nginx resolveriam a execução, mas adicionam uma camada de orquestração ou de renovação manual de certificado sem ganho claro no porte deste projeto.

## Consequências

- **Ponto único de falha:** API, banco e fila na mesma VPS tornam essa VPS o único ponto de falha diante do SLA de 99,5% (≈ 3,6 h de indisponibilidade tolerada por mês). Aceito no MVP; mitigado por monitoramento (E2-H11) e por backup com restauração testada (E2-H7), com tempo de recuperação alvo a definir na E2-H7.
- O arquivo de ambiente (`/etc/citmail/api.env` no exemplo acima) guarda os segredos com permissão `600`, dono `<usuario-de-servico>`, nunca no repositório (regra da CIT-46).
- `ProtectSystem=strict` deixa o sistema de arquivos só leitura para o serviço; pastas que precisem de escrita entram em `ReadWritePaths`.
- Restaurar um backup exige a chave privada, que não está na VPS: o procedimento da E2-H7 documenta onde buscá-la.
- O provedor do armazenamento externo de backup é decidido na E2-H7; este ADR só fixa o tipo e as regras.
- A porta SSH, o usuário de deploy e o host da VPS ficam fora deste repositório público; documentados só no ambiente de CI (`SSH_HOST`, `SSH_PORT`, `SSH_USER` do `publicar-homologacao.yml`) e no gerenciador de segredos da equipe.

## Revisões

- 2026-09-25: criação (CIT-47).
- 2026-09-25: ajustes da revisão (CIT-47).
- 2026-09-26: aceito pelo responsável (CIT-47). Itens em "Decisões em aberto" do README e revisões previstas pela #48 continuam valendo.
- 2026-10-01: worker da fila como processo próprio, com `npm run worker` (`node src/worker.js`) como comando da futura unidade `systemd` da #57; o worker não lê banco nem CORS e encerra no SIGTERM esperando o job ativo e os alertas em curso (um segundo sinal é ignorado). A unidade do worker precisa de `TimeoutStopSec` maior que a duração máxima de um job mais alguns segundos para o alerta; senão o systemd mata o processo no meio do encerramento (CIT-56).
