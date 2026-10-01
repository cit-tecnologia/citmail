// @ts-check
import { test, expect } from './fixtures.js';
// CIT-22: guarda de carga (assets/precos.js não carrega) — espera erro de propósito, por isso usa o
// `test` puro do Playwright em vez da fixture `erros` (que falharia com qualquer erro registrado).
import { test as testSemErros } from '@playwright/test';
import { readFileSync } from 'node:fs';

// CIT-15: ajuste de textos e componentes da landing (index.html).
// Cada teste roda nos dois perfis configurados em playwright.config.js (desktop e mobile).

/**
 * Cor calculada de var(--cit-success) na página, lida de um elemento sonda,
 * para os testes não fixarem o valor do token.
 * @param {import('@playwright/test').Page} page
 */
async function corSucesso(page) {
  return page.evaluate(() => {
    const sonda = document.createElement('div');
    sonda.style.backgroundColor = 'var(--cit-success)';
    document.body.appendChild(sonda);
    const cor = getComputedStyle(sonda).backgroundColor;
    sonda.remove();
    return cor;
  });
}

// ---------------------------------------------------------------------------------------------------
// CIT-50: literais aprovados da landing (plano .omc/plans/CIT-50.md, seção "Textos finais"), num lugar só.
// Quem altera estas constantes: #48 (recursos da PoC Skymail: backup, IA, agenda, Talk, armazenamento),
// #109 (depoimentos reais) e #51 (links de Privacidade/Termos no rodapé e frase da Política no FAQ).
// ---------------------------------------------------------------------------------------------------

// Promessas fora do lançamento: nenhum item pode casar no texto visível, na meta ou em aria-label/alt/title.
// `\b` nos termos curtos (chat, Talk, SLA) evita falso positivo em palavras maiores.
const TERMOS_PROIBIDOS = [
  /2FA/i, /dois fatores/i, /duas etapas/i, /\bchat\b/i, /transferimos/i, /transferência de domínio/i,
  /IA inclusa/i, /IA para escrita/i, /Agenda de contatos/i, /Calendário/i, /apelidos/i, /aliases/i,
  /Backup automático/i, /Backup adicional/i, /Armazenamento em nuvem/i, /\bTalk\b/i, /parcelamento/i,
  /Enterprise/i, /\bSLA\b/i, /prioritário/i, /24\/7/i, /500\+/i, /Clientes ativos/i, /garantida/i,
  /resposta média/i, /Registramos/i, /criamos o domínio/i, /ajuste o DNS/i, /armazenamento/i,
  /pelo mesmo painel/i, /Add-ons/i, /proporcional/i, /R\$\s*19,90/i, /está disponível para registro/i,
];

const META_DESCRIPTION = 'CITMail: e-mail corporativo com o domínio da sua empresa. Contas de 5, 25 e 50 GB, com webmail, antispam e painel de gestão.';
const TRUST_ITEMS = [
  'Proteção antivírus e antispam',
  'SSL/TLS em todas as conexões',
  'Suporte por ticket e e-mail em dias úteis, das 08h00 às 18h00',
  'Dados tratados conforme a LGPD',
];
const FEATURE_TITULOS = ['Domínio Próprio', 'Webmail', 'Apps de E-mail', 'Antispam & Antivírus', 'Painel de Controle'];
const MARKETPLACE_CARDS = [
  { titulo: 'E-mail Corporativo', badge: 'Incluído' },
  { titulo: 'E-mail Registrado', badge: 'Sob consulta' },
  { titulo: 'Microsoft 365', badge: 'Sob consulta' },
];
const INCLUSO_ITENS = [
  'Webmail para computador e celular',
  'Protocolos IMAP / POP3 / SMTP',
  'Antispam e antivírus',
  'Certificado SSL/TLS grátis',
  'Painel de gerenciamento',
  'Compatível com Outlook, Gmail App e Apple Mail',
];
const PAINEL_ITENS = [
  'Dashboard com visão geral do plano',
  'Criação e exclusão de caixas de e-mail',
  'Troca de senhas pelo próprio cliente',
  'Histórico de faturas com download em PDF',
  'Registros de DNS e status da verificação do domínio',
];
const CARD50_STORAGE = '50 GB por caixa · IMAP/POP3/SMTP · Webmail';
const BUSCA_H2 = 'Consulte o domínio da sua empresa';
const BUSCA_P = 'Digite o nome da empresa e veja se o domínio parece livre. A disponibilidade é confirmada na contratação.';
const BUSCA_LIVRE = 'empresaficticia50.com.br parece disponível. A confirmação é feita na contratação.';
const BUSCA_OCUPADO = 'citmail.com.br parece já estar registrado. Tente outro nome ou extensão.';
const MARKETPLACE_SUBTITULO = 'E-mail Registrado e Microsoft 365 sob consulta, contratados junto com o e-mail.';
const FEATURE_DESCRICOES = {
  0: 'Use o domínio que a empresa já tem ou peça o registro de um novo na contratação. Configuramos DNS, MX, SPF, DKIM e DMARC.',
  4: 'Gerencie caixas de e-mail, senhas e faturas sem precisar acionar o suporte.',
};
const NOTA_DOMINIO_INCLUSO = 'Domínio não incluído: use um domínio que a empresa já tem ou peça o registro de um novo na contratação.';
const PAINEL_SUBTITULO = 'Crie caixas, troque senhas, baixe faturas e consulte o DNS pelo painel, sem depender do suporte.';
const NOTA_CANCELAMENTO = 'O serviço segue até o fim do ciclo pago.';
const PASSOS_COMO_FUNCIONA = [
  null, // passo 1 (igual): fora do escopo do CA2 (só os passos 2 a 4 mudaram)
  'Pix, boleto ou cartão de crédito, pela fatura do Asaas. A cobrança se renova automaticamente.',
  'Com o seu domínio, as caixas ficam prontas em até 5 minutos após a confirmação do pagamento. Domínio novo leva mais tempo, porque o registro é feito pela nossa equipe.',
  'As credenciais chegam por e-mail. No painel, você gerencia caixas e faturas e consulta os registros de DNS.',
];
/** @type {[string, string][]} pares [pergunta, resposta] na ordem da página */
const FAQ_LITERAIS = [
  ['Preciso ter um domínio próprio para contratar?', 'Não. Se a empresa já tem um domínio, basta apontar os registros de DNS para nós; o painel mostra quais são. Se ainda não tem, peça o registro de um domínio novo na contratação. O domínio fica em nome da sua empresa.'],
  ['Quanto tempo leva para o e-mail ser ativado?', 'Com um domínio que a empresa já tem, as caixas ficam prontas em até 5 minutos após a confirmação do pagamento, e as credenciais chegam por e-mail. Para enviar e receber mensagens, os registros de DNS precisam estar apontados; a propagação leva até 48 horas e costuma terminar antes. Com domínio novo, o prazo é maior, porque o registro é feito pela nossa equipe. Avisamos por e-mail quando terminar.'],
  ['Quais formas de pagamento são aceitas?', 'Pix, boleto bancário ou cartão de crédito, pela fatura do Asaas. O Pix é confirmado na hora; o boleto, em até 3 dias úteis. Planos mensais e anuais se renovam automaticamente.'],
  ['Posso adicionar mais caixas de e-mail depois?', 'Sim, pelo painel, a qualquer momento.'],
  ['Como funciona o suporte técnico?', 'Por ticket no painel e por e-mail, em dias úteis, das 08h00 às 18h00.'],
  ['O serviço é compatível com Outlook, Gmail e Apple Mail?', 'Sim. O serviço usa IMAP, POP3 e SMTP e funciona com Outlook, Apple Mail, Thunderbird, Gmail App e outros clientes. As configurações chegam por e-mail após a ativação.'],
  ['Posso cancelar quando quiser?', 'Sim. Não há fidelidade nem multa. Você pede o cancelamento pelo painel; o serviço segue ativo até o fim do ciclo já pago e não há nova cobrança. Na primeira contratação, você pode desistir em até 7 dias e recebe de volta o valor pago (Código de Defesa do Consumidor, art. 49).'],
  // #51: a resposta 8 (índice 7) volta a citar a Política de Privacidade; reescrever o literal.
  ['Os dados são protegidos pela LGPD?', 'Sim. Tratamos os dados conforme a Lei Geral de Proteção de Dados (LGPD). As senhas do painel são guardadas com hash Argon2id e todas as conexões usam TLS. Para pedir acesso, correção ou exclusão dos seus dados, escreva para o encarregado: privacidade@cittecnologia.com.br.'],
];
// #51: tira 'Política de Privacidade' e 'Termos de Uso' desta lista (os links voltam ao rodapé).
const RODAPE_TEXTOS_REMOVIDOS = ['Sobre nós', 'Blog', 'Parceiros', 'Política de Privacidade', 'Termos de Uso'];
// #51: a coluna passa a ter também os links de Privacidade e Termos (acrescentar aqui, com o href das páginas novas).
const RODAPE_SUPORTE = [
  { texto: 'FAQ', href: '#faq' },
  { texto: 'Painel do Cliente', href: 'login.html' },
  { texto: 'Contato', href: 'mailto:comercial@citmail.com.br' },
];
const RODAPE_LEGAL = '© 2026 CITMail · CIT TECNOLOGIA DA INFORMACAO LTDA - ME · CNPJ 22.080.376/0001-96';

test.describe('landing — hero', { tag: '@CIT-15' }, () => {
  test('h1 exibe o texto final com destaque em "e-mail profissional"', async ({ page, erros }) => {
    await page.goto('index.html');
    const h1 = page.locator('.hero-title');
    await expect(h1).toHaveText('Eleve o nível da sua marca com um e-mail profissional personalizado');
    await expect(h1.locator('.highlight')).toHaveText('e-mail profissional');
  });

  test('h1 não estoura a largura do documento', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.hero-title')).toBeVisible();
    const [scrollWidth, clientWidth] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  for (const largura of [320, 360]) {
    test(`h1 cabe na largura útil em telas de ${largura}px sem quebrar "e-mail" no hífen`, async ({ page, erros }) => {
      await page.setViewportSize({ width: largura, height: 800 });
      await page.goto('index.html');
      await expect(page.locator('.hero-title')).toBeVisible();
      // a coluna do hero é alargada pelo mockup ao lado (fora do escopo), então o h1 é medido
      // restrito à largura útil do container: nenhum trecho do título pode passar dela
      const medida = await page.evaluate(() => {
        const h1 = /** @type {HTMLElement} */ (document.querySelector('.hero-title'));
        const container = /** @type {HTMLElement} */ (h1.closest('.container'));
        const estilo = getComputedStyle(container);
        const util = document.documentElement.clientWidth - parseFloat(estilo.paddingLeft) - parseFloat(estilo.paddingRight);
        h1.style.width = `${util}px`;
        const palavra = /** @type {HTMLElement} */ (h1.querySelector('.highlight .nowrap-word'));
        return { util, scrollWidth: h1.scrollWidth, linhasEmail: palavra.getClientRects().length, textoEmail: palavra.textContent };
      });
      expect(medida.scrollWidth).toBeLessThanOrEqual(medida.util);
      expect(medida.textoEmail).toBe('e-mail');
      expect(medida.linhasEmail).toBe(1);
    });
  }

  test('subtítulo do hero exibe o texto final', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.hero-subtitle')).toHaveText(
      'Os e-mails da sua empresa com domínio próprio (exemplo: suaempresa.com.br) com segurança e praticidade. Gerencie suas contas diretamente no painel, sem complicações.'
    );
  });

  test('1º indicador do hero mostra o ícone headset e o rótulo de suporte', async ({ page, erros }) => {
    await page.goto('index.html');
    const primeiro = page.locator('.hero-stat').nth(0);
    // o Vite reescreve "assets/..." para "/citmail/assets/..." ao servir, por isso o teste checa só o sufixo
    await expect(primeiro.locator('.number use')).toHaveAttribute('href', /icons\.svg#headset$/);
    await expect(primeiro.locator('.number svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(primeiro.locator('.label')).toHaveText('Suporte técnico humanizado');
  });

  test('2º indicador do hero mostra a meta de disponibilidade e o 3º mostra a ativação após o pagamento', async ({ page, erros }) => {
    await page.goto('index.html');
    const stats = page.locator('.hero-stat');
    await expect(stats.nth(1).locator('.number')).toHaveText('99,5%');
    await expect(stats.nth(1).locator('.label')).toHaveText('Meta de disponibilidade');
    // CIT-50: "500+ Clientes ativos" saiu (dado não comprovado)
    await expect(stats.nth(2).locator('.number')).toHaveText('5 min');
    await expect(stats.nth(2).locator('.label')).toHaveText('Ativação após o pagamento');
  });

  test('selo flutuante "Ativo em 5 min" foi removido do hero', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.hero-float-2')).toHaveCount(0);
    // guarda de regressão: o outro selo flutuante continua no lugar
    await expect(page.locator('.hero-float-1')).toHaveCount(1);
  });
});

test.describe('landing — faixa de confiança', { tag: '@CIT-15' }, () => {
  test('faixa de confiança tem 4 itens e não cita pagamento recorrente nem meios de pagamento', async ({ page, erros }) => {
    await page.goto('index.html');
    const itens = page.locator('.trust-bar-inner .trust-item');
    await expect(itens).toHaveCount(4);
    const texto = await itens.allInnerTexts();
    expect(texto.join(' ')).not.toContain('Pagamento recorrente automático');
    expect(texto.join(' ')).not.toContain('Pix, boleto e cartão');
  });
});

test.describe('landing — recursos e domínio', { tag: '@CIT-15' }, () => {
  test('subtítulo da seção Recursos exibe o texto final', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#features .section-header p')).toHaveText(
      'Domínio, webmail, apps e antispam num só contrato, gerenciados pelo painel.'
    );
  });

  test('prefixo do campo de domínio mostra só "@", sem ícone', async ({ page, erros }) => {
    await page.goto('index.html');
    const prefixo = page.locator('.domain-prefix');
    // toHaveText (não toBeVisible): o prefixo fica oculto por CSS em telas ≤600px
    await expect(prefixo).toHaveText('@');
    await expect(prefixo.locator('svg')).toHaveCount(0);
  });

  test('chip .com foi removido e o .com.br continua ativo', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.tld-chip[data-tld=".com"]')).toHaveCount(0);
    // guarda de regressão: os demais chips continuam presentes e o .com.br segue selecionado
    await expect(page.locator('.tld-chip[data-tld=".com.br"]')).toHaveClass(/active/);
    await expect(page.locator('.tld-chip[data-tld=".net.br"]')).toHaveCount(1);
    await expect(page.locator('.tld-chip[data-tld=".org.br"]')).toHaveCount(1);
    await expect(page.locator('.tld-chip[data-tld=".adv.br"]')).toHaveCount(1);
    await expect(page.locator('.tld-chip[data-tld=".med.br"]')).toHaveCount(1);
  });
});

test.describe('landing — plano anual', { tag: '@CIT-15' }, () => {
  test('toggle mensal/anual fica verde só no anual e volta à cor inicial no mensal', async ({ page, erros }) => {
    await page.goto('index.html');
    const verde = await corSucesso(page);
    const toggle = page.locator('#billingToggle');
    await toggle.scrollIntoViewIfNeeded();
    // lê o valor inicial em vez de fixar a cor azul, para não acoplar o teste a um token específico
    const corInicial = await toggle.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(corInicial).not.toBe(verde);

    await toggle.click();
    await expect(toggle).toHaveCSS('background-color', verde);

    await toggle.click();
    await expect(toggle).toHaveCSS('background-color', corInicial);
  });
});

test.describe('landing — quantidade de contas', { tag: '@CIT-15' }, () => {
  test('plano de 5 GB: botões e digitação respeitam o mínimo de 2 contas', async ({ page, erros }) => {
    await page.goto('index.html');
    const card = page.locator('#card5');
    const input = page.locator('#qty5');
    const aumentar = card.getByRole('button', { name: 'Aumentar' });
    const diminuir = card.getByRole('button', { name: 'Diminuir' });

    await aumentar.click();
    await expect(input).toHaveValue('2');

    // abaixo do mínimo zera em um único clique
    await diminuir.click();
    await expect(input).toHaveValue('0');

    await input.fill('1');
    await input.press('Tab');
    await expect(input).toHaveValue('2');

    await input.fill('-3');
    await input.press('Tab');
    await expect(input).toHaveValue('0');
  });

  test('plano de 5 GB: diminuir de 3 contas vai para 2', async ({ page, erros }) => {
    await page.goto('index.html');
    const input = page.locator('#qty5');
    await input.fill('3');
    await input.press('Tab');
    await expect(input).toHaveValue('3');

    await page.locator('#card5').getByRole('button', { name: 'Diminuir' }).click();
    await expect(input).toHaveValue('2');
  });

  test('planos de 25 GB e 50 GB aceitam quantidade mínima de 1 conta', async ({ page, erros }) => {
    await page.goto('index.html');
    const qty25 = page.locator('#qty25');
    const qty50 = page.locator('#qty50');

    await page.locator('#card25').getByRole('button', { name: 'Aumentar' }).click();
    await expect(qty25).toHaveValue('1');

    await page.locator('#card25').getByRole('button', { name: 'Diminuir' }).click();
    await expect(qty25).toHaveValue('0');

    await qty50.fill('1');
    await qty50.press('Tab');
    await expect(qty50).toHaveValue('1');
  });

  test('href do CTA de contratação reflete a quantidade escolhida (qty25=1)', async ({ page, erros }) => {
    await page.goto('index.html');
    const qty25 = page.locator('#qty25');
    await qty25.fill('1');
    await qty25.press('Tab');
    await expect(page.locator('#calcCtaBtn')).toHaveAttribute('href', /qty25=1/);
  });

  test('textos de mínimo de contas: só o card de 5 GB cita "Mínimo 2 contas"', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#card5 .atc-storage')).toContainText('Mínimo 2 contas');
    await expect(page.locator('#card25 .atc-storage')).not.toContainText('Mínimo 2 contas');
    await expect(page.locator('#card50 .atc-storage')).not.toContainText('Mínimo 2 contas');
    await expect(page.locator('.discount-info strong').first()).toHaveText('Mínimo de 2 contas no plano de 5 GB.');
  });
});

test.describe('landing — marketplace', { tag: '@CIT-15' }, () => {
  test('marketplace exibe os 3 serviços na ordem, com selos e ícones corretos', async ({ page, erros }) => {
    await page.goto('index.html');
    const cards = page.locator('#marketplace .marketplace-card');
    // CIT-50: Backup adicional, Armazenamento em nuvem e Talk saíram até a PoC da Skymail (#48)
    await expect(cards).toHaveCount(3);

    const esperado = [
      { titulo: 'E-mail Corporativo', badge: 'Incluído', icone: 'mail' },
      { titulo: 'E-mail Registrado', badge: 'Sob consulta', icone: 'mail-check' },
      { titulo: 'Microsoft 365', badge: 'Sob consulta', icone: 'laptop' },
    ];

    for (let i = 0; i < esperado.length; i++) {
      const card = cards.nth(i);
      await expect(card.locator('h3')).toHaveText(esperado[i].titulo);
      await expect(card.locator('.badge')).toHaveText(esperado[i].badge);
      await expect(card.locator('.marketplace-icon use')).toHaveAttribute(
        'href', new RegExp(`icons\\.svg#${esperado[i].icone}$`)
      );
    }
  });

  test('marketplace exibe as descrições finais dos serviços', async ({ page, erros }) => {
    await page.goto('index.html');
    const cards = page.locator('#marketplace .marketplace-card');
    // CIT-50: restam 3 serviços; os textos das descrições não mudam
    const descricoes = [
      'Caixas de e-mail com domínio próprio, webmail, IMAP/POP3/SMTP e proteção antispam.',
      'Para comunicações que exigem formalidade e comprovação, o E-mail Registrado substitui processos burocráticos com eficiência e validade jurídica. Ideal para empresas que valorizam rastreabilidade, proteção e conformidade.',
      'E-mail, OneDrive, aplicativos online e offline. Planos que se encaixam desde pequenas a grandes empresas, que desejam escalar com aplicativos de produtividade da Microsoft.',
    ];
    for (let i = 0; i < descricoes.length; i++) {
      await expect(cards.nth(i).locator('p')).toHaveText(descricoes[i]);
    }
  });

  test('marketplace não exibe preços nem os cards antigos de Servidores/DevOps', async ({ page, erros }) => {
    await page.goto('index.html');
    const marketplace = page.locator('#marketplace');
    await expect(marketplace.locator('.from')).toHaveCount(0);
    await expect(marketplace.locator('.price')).toHaveCount(0);
    await expect(marketplace).not.toContainText('Servidores Cloud');
    await expect(marketplace).not.toContainText('DevOps');
    await expect(marketplace).not.toContainText('Backup, servidores e consultoria de TI');
  });

  test('grade do marketplace usa 3 colunas no desktop e 1 no mobile', async ({ page, erros }, testInfo) => {
    await page.goto('index.html');
    const grid = page.locator('#marketplace .marketplace-grid');
    const colunas = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    const esperado = testInfo.project.name === 'mobile' ? 1 : 3;
    expect(colunas).toBe(esperado);
  });

  test('grade do marketplace usa 2 colunas em telas intermediárias (800px)', async ({ page, erros }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto('index.html');
    const grid = page.locator('#marketplace .marketplace-grid');
    const colunas = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(colunas).toBe(2);
  });
});

test.describe('landing — textos, FAQ e meta', { tag: '@CIT-15' }, () => {
  test('"5 min" só aparece no hero, em Como funciona e na resposta 2 do FAQ, e nunca em meta ou atributos', async ({ page, erros }) => {
    await page.goto('index.html');
    // CIT-50 (CA1 f): o texto de prazo é permitido nesses três lugares; o resto do HTML segue sem "5 min"
    const { fora, atributos } = await page.evaluate(([perguntaPrazo]) => {
      const clone = /** @type {HTMLElement} */ (document.body.cloneNode(true));
      clone.querySelectorAll('script, style, noscript, .hero-stats, #how-it-works').forEach(el => el.remove());
      clone.querySelectorAll('.faq-item').forEach(item => {
        if (item.querySelector('.faq-question span')?.textContent?.trim() === perguntaPrazo) item.remove();
      });
      const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const attrs = [...document.querySelectorAll('[aria-label], [alt], [title]')].flatMap(el =>
        ['aria-label', 'alt', 'title'].map(a => el.getAttribute(a) || ''));
      return { fora: clone.textContent || '', atributos: [meta, ...attrs].join('\n') };
    }, [FAQ_LITERAIS[1][0]]);
    expect(fora, 'ocorrência de "5 min" fora de .hero-stats, #how-it-works e resposta 2 do FAQ').not.toMatch(/\b5\s*min/i);
    expect(atributos, '"5 min" em meta/aria-label/alt/title').not.toMatch(/\b5\s*min/i);
  });

  test('FAQ de DNS exibe o texto final', async ({ page, erros }) => {
    await page.goto('index.html');
    // CIT-50: texto da resposta 2 reescrito (literal em FAQ_LITERAIS, CA2)
    const resposta = page.locator('.faq-answer p').filter({ hasText: 'até 48 horas' });
    await expect(resposta).toHaveText(FAQ_LITERAIS[1][1]);
  });

  test('<title> da landing permanece inalterado', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page).toHaveTitle('CITMail — E-mail corporativo com domínio próprio');
  });
});

// CIT-22, Passo 5: preço de tabela riscado, regra do checkout (anual sem volume) e recálculo na carga.
// Termos do plano: "atual" = preço de lista de hoje; "tabela" = atual / 0,85, arredondado ao centavo;
// "cobrado" = o que entra no total; "economia" = Σ por item de (tabela − cobrado).

/**
 * CIT-22: cor computada de um token de cor qualquer, lida de um elemento sonda,
 * para os testes não fixarem o valor do token.
 * @param {import('@playwright/test').Page} page
 * @param {string} token
 */
async function corToken(page, token) {
  return page.evaluate((tok) => {
    const sonda = document.createElement('div');
    sonda.style.backgroundColor = `var(${tok})`;
    document.body.appendChild(sonda);
    const cor = getComputedStyle(sonda).backgroundColor;
    sonda.remove();
    return cor;
  }, token);
}

/**
 * CIT-22: contraste (WCAG) de um elemento contra um token de cor de fundo específico — usado para o
 * card selecionado da landing, cujo fundo é um gradiente (a cor efetiva não dá para compor via
 * backgroundColor dos ancestrais); a decisão do plano mede contra `--cit-blue-50` (pior ponto do gradiente).
 * @param {import('@playwright/test').Page} page
 * @param {string} seletor
 * @param {string} tokenFundo
 */
async function contrasteContraFundo(page, seletor, tokenFundo) {
  return page.evaluate(([sel, tok]) => {
    const rgba = (/** @type {string} */ c) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (/** @type {number[]} */ [r, g, b]) => {
      const f = (/** @type {number} */ v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const sonda = document.createElement('div');
    sonda.style.backgroundColor = `var(${tok})`;
    document.body.appendChild(sonda);
    const fundo = rgba(getComputedStyle(sonda).backgroundColor);
    sonda.remove();
    const el = /** @type {Element} */ (document.querySelector(sel));
    const cor = rgba(getComputedStyle(el).color);
    const l1 = lum(cor.slice(0, 3));
    const l2 = lum(fundo.slice(0, 3));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }, [seletor, tokenFundo]);
}

test.describe('landing — CIT-22: economia com e sem volume no mensal (CA3)', { tag: '@CIT-22' }, () => {
  test('10×5GB mensal: tabela, −15% contratação, −5% volume e economia', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '10'));
    await expect(page.locator('#csSummaryLines .cs-disc')).toHaveText(
      'de R$ 117,60 · −15% contratação −R$ 17,60 · −5% volume −R$ 5,00'
    );
    await expect(page.locator('#csTotal')).toHaveText('R$ 95,00');
    await expect(page.locator('#csEconomia')).toHaveText('Você economiza R$ 22,60/mês');
  });

  test('4×5GB mensal: sem volume, só a contratação', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '4'));
    await expect(page.locator('#csSummaryLines .cs-disc')).toHaveText('de R$ 47,04 · −15% contratação −R$ 7,04');
    await expect(page.locator('#csTotal')).toHaveText('R$ 40,00');
    await expect(page.locator('#csEconomia')).toHaveText('Você economiza R$ 7,04/mês');
  });

  test('5×5GB mensal: "−15% contratação" é Σ(tabela − atual), não 15% da tabela (−R$ 8,80, não 8,82)', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '5'));
    await expect(page.locator('#csSummaryLines .cs-disc')).toContainText('−15% contratação −R$ 8,80');
    await expect(page.locator('#csSummaryLines .cs-disc')).not.toContainText('8,82');
  });
});

test.describe('landing — CIT-22: rótulos com 15% e sem frases de urgência falsa (CA4)', { tag: '@CIT-22' }, () => {
  const PROIBIDAS = [/volta ao preço/i, /voltará/i, /por tempo limitado/i, /oferta termina/i, /até o dia/i, /últimos dias/i, /preço original/i, /somente hoje/i];

  test('"15%" aparece no texto da seção de preços e na .discount-info', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#pricing .section-header p')).toContainText('15%');
    await expect(page.locator('.discount-info')).toContainText('15%');
  });

  test('.discount-info, cards de conta e .calc-summary não citam frases de urgência falsa (lista fechada)', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '2'));

    const textos = await page.evaluate(() => {
      const sels = ['.discount-info', '#card5', '#card25', '#card50', '.calc-summary'];
      return sels.map(sel => /** @type {[string, string]} */ ([sel, document.querySelector(sel)?.textContent || '']));
    });
    for (const [sel, texto] of textos) {
      for (const re of PROIBIDAS) expect(texto, `${sel} não deveria casar com ${re}`).not.toMatch(re);
    }
  });
});

test.describe('landing — CIT-22: cards sem quantidade mostram a tabela riscada (CA5)', { tag: '@CIT-22' }, () => {
  test('mensal: "de"/"por" nos três cards, sem quantidade', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#card5 .atc-unit-tabela')).toHaveText('de R$ 11,76');
    await expect(page.locator('#unitPrice5')).toHaveText('por R$ 10,00');
    await expect(page.locator('#card25 .atc-unit-tabela')).toHaveText('de R$ 18,82');
    await expect(page.locator('#unitPrice25')).toHaveText('por R$ 16,00');
    await expect(page.locator('#card50 .atc-unit-tabela')).toHaveText('de R$ 29,41');
    await expect(page.locator('#unitPrice50')).toHaveText('por R$ 25,00');
    // Guarda de regressão (CA1): o primeiro <strong> do aviso de desconto não muda nesta história.
    await expect(page.locator('.discount-info strong').first()).toHaveText('Mínimo de 2 contas no plano de 5 GB.');
  });

  test('anual: "de"/"por" nos três cards, sem quantidade', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.locator('#billingToggle').click();
    await expect(page.locator('#card5 .atc-unit-tabela')).toHaveText('de R$ 11,76');
    await expect(page.locator('#unitPrice5')).toHaveText('por R$ 8,00');
    await expect(page.locator('#card25 .atc-unit-tabela')).toHaveText('de R$ 18,82');
    await expect(page.locator('#unitPrice25')).toHaveText('por R$ 12,80');
    await expect(page.locator('#card50 .atc-unit-tabela')).toHaveText('de R$ 29,41');
    await expect(page.locator('#unitPrice50')).toHaveText('por R$ 20,00');
  });
});

test.describe('landing — CIT-22: subtotal do card com quantidade (CA6)', { tag: '@CIT-22' }, () => {
  test('2×5GB mensal: de/por/economia no card', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '2'));
    await expect(page.locator('#origPrice5')).toHaveText('R$ 23,52');
    await expect(page.locator('#finalPrice5')).toHaveText('por R$ 20,00/mês');
    await expect(page.locator('#saving5')).toHaveText('economia −R$ 3,52/mês');
  });
});

test.describe('landing — CIT-22: resumo da calculadora linha a linha (CA6)', { tag: '@CIT-22' }, () => {
  test('2×5GB mensal: linha, cascata, "Total de tabela", total e economia', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '2'));

    const linha = page.locator('#csSummaryLines .cs-line').first();
    await expect(linha.locator('.lbl')).toHaveText('2× E-mail 5 GB');
    await expect(linha.locator('.val')).toHaveText('R$ 20,00');
    await expect(page.locator('#csSummaryLines .cs-disc')).toHaveText('de R$ 23,52 · −15% contratação −R$ 3,52');

    const totalTabela = page.locator('#csSummaryLines .cs-line').last();
    await expect(totalTabela.locator('.lbl')).toHaveText('Total de tabela');
    await expect(totalTabela.locator('.val')).toHaveText('R$ 23,52');
    await expect(page.locator('#csTotal')).toHaveText('R$ 20,00');
    await expect(page.locator('#csEconomia')).toHaveText('Você economiza R$ 3,52/mês');
  });

  test('2×5GB anual: linha, cascata com −20% anual, "Total de tabela", total e economia anual', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => { updateQty('5gb', '2'); setBilling('annual'); });

    const linha = page.locator('#csSummaryLines .cs-line').first();
    await expect(linha.locator('.lbl')).toHaveText('2× E-mail 5 GB');
    await expect(linha.locator('.val')).toHaveText('R$ 16,00');
    await expect(page.locator('#csSummaryLines .cs-disc')).toHaveText('de R$ 23,52 · −15% contratação −R$ 3,52 · −20% anual −R$ 4,00');

    const totalTabela = page.locator('#csSummaryLines .cs-line').last();
    await expect(totalTabela.locator('.val')).toHaveText('R$ 23,52');
    await expect(page.locator('#csTotal')).toHaveText('R$ 16,00');
    await expect(page.locator('#csEconomia')).toHaveText('Você economiza R$ 7,52/mês (R$ 90,24/ano)');
  });

  test('2×5GB + 1×25GB mensal: nenhuma linha "Desc.", uma .cs-disc por tipo, e todo riscado do resumo é valor de tabela', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => { updateQty('5gb', '2'); updateQty('25gb', '1'); });

    const rotulos = await page.locator('#csSummaryLines .cs-line .lbl').allTextContents();
    expect(rotulos.some(r => r.startsWith('Desc.')), `rótulos: ${rotulos.join(', ')}`).toBe(false);
    await expect(page.locator('#csSummaryLines .cs-disc')).toHaveCount(2);

    const riscados = await page.locator('#csLines s').allTextContents();
    expect(riscados).toEqual(['R$ 23,52', 'R$ 18,82', 'R$ 42,34']);
    expect(riscados).not.toContain('R$ 20,00');
    expect(riscados).not.toContain('R$ 36,00');
  });
});

test.describe('landing — CIT-22: paridade com o checkout e selo de volume só no mensal (CA7)', { tag: '@CIT-22' }, () => {
  /** @type {{ tipo: '5gb'|'25gb'|'50gb', qty: number, anual: boolean, total: string }[]} */
  const CASOS = [
    { tipo: '5gb', qty: 5, anual: true, total: 'R$ 40,00' },
    { tipo: '25gb', qty: 5, anual: false, total: 'R$ 76,00' },
    { tipo: '5gb', qty: 2, anual: true, total: 'R$ 16,00' },
  ];

  for (const c of CASOS) {
    test(`${c.qty}×${c.tipo} ${c.anual ? 'anual' : 'mensal'}: #csTotal igual ao #sumTotal do checkout`, async ({ page, erros }) => {
      await page.goto('index.html');
      await page.evaluate(([tipo, qty, anual]) => {
        // @ts-ignore — tipo vem de ACCOUNT_TYPES, definido no script inline da página
        updateQty(tipo, String(qty));
        if (anual) setBilling('annual');
      }, [c.tipo, c.qty, c.anual]);
      await expect(page.locator('#csTotal')).toHaveText(c.total);
    });
  }

  test('selo "−5% por volume aplicado" e dica de volume só aparecem no mensal', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '5'));
    await expect(page.locator('#discTag5')).toContainText('volume aplicado');

    await page.evaluate(() => setBilling('annual'));
    await expect(page.locator('#discTag5')).toHaveText('');
  });

  test('dica "Adicione mais N conta(s)" aparece no mensal com menos de 5 contas e fica ausente no anual', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '2'));
    await expect(page.locator('#discTag5')).toContainText('Adicione mais 3 conta(s)');

    await page.evaluate(() => setBilling('annual'));
    await expect(page.locator('#discTag5')).toHaveText('');
  });

  for (const c of CASOS) {
    test(`${c.qty}×${c.tipo} ${c.anual ? 'anual' : 'mensal'}: seguindo o href do CTA, #sumTotal do checkout confere com o #csTotal lido antes`, async ({ page, erros }) => {
      await page.goto('index.html');
      await page.evaluate(([tipo, qty, anual]) => {
        // @ts-ignore — tipo vem de ACCOUNT_TYPES, definido no script inline da página
        updateQty(tipo, String(qty));
        if (anual) setBilling('annual');
      }, [c.tipo, c.qty, c.anual]);

      const totalLanding = (await page.locator('#csTotal').textContent()).trim();
      expect(totalLanding).toBe(c.total);
      const href = await page.locator('#calcCtaBtn').getAttribute('href');

      await page.goto(/** @type {string} */ (href));
      await expect(page.locator('#sumTotal')).toHaveText(totalLanding);
    });
  }
});

test.describe('landing — CIT-22: cores dos riscados e dos preços cobrados (CA12)', { tag: '@CIT-22' }, () => {
  test('riscado usa --cit-error; preço final e economia usam --cit-success-strong, nunca --cit-success nem --gray-400', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '2'));

    const erro = await corToken(page, '--cit-error');
    const sucessoForte = await corToken(page, '--cit-success-strong');
    const sucesso = await corToken(page, '--cit-success');
    const cinza400 = await corToken(page, '--gray-400');
    expect(sucessoForte).not.toBe(sucesso);

    await expect(page.locator('#card5 [data-preco-tabela="conta:5gb"]')).toHaveCSS('color', erro);
    await expect(page.locator('#finalPrice5')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#csEconomia')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#finalPrice5')).not.toHaveCSS('color', sucesso);
    await expect(page.locator('#csEconomia')).not.toHaveCSS('color', sucesso);

    // "Total de tabela" (linha final do resumo): nem --cit-success nem --gray-400 (era grandFull em --gray-400 antes da CIT-22).
    const totalTabelaVal = page.locator('#csSummaryLines .cs-line').last().locator('.val');
    await expect(totalTabelaVal).not.toHaveCSS('color', cinza400);
    await expect(totalTabelaVal).not.toHaveCSS('color', sucesso);
  });

  test('.atc-unit-price .price e .cs-line .val do item usam --cit-success-strong; #csTotal (total geral) não muda', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '2'));

    const sucessoForte = await corToken(page, '--cit-success-strong');
    await expect(page.locator('#card5 .atc-unit-price .price')).toHaveCSS('color', sucessoForte);
    await expect(page.locator('#csSummaryLines .cs-line .val').first()).toHaveCSS('color', sucessoForte);

    // Guarda de regressão (CA12): #csTotal (total geral da calculadora) mantém a cor de hoje.
    await expect(page.locator('#csTotal')).not.toHaveCSS('color', sucessoForte);
  });
});

test.describe('landing — CIT-22: contraste no card selecionado, medido contra --cit-blue-50 (CA13)', { tag: '@CIT-22' }, () => {
  test('riscado e preço cobrado têm contraste de pelo menos 4,5:1 no pior ponto do gradiente do card selecionado', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => updateQty('5gb', '2'));
    await expect(page.locator('#card5')).toHaveClass(/has-qty/);

    const cRiscado = await contrasteContraFundo(page, '#card5 [data-preco-tabela="conta:5gb"]', '--cit-blue-50');
    const cFinal = await contrasteContraFundo(page, '#card5 .price-final', '--cit-blue-50');
    expect(cRiscado, 'contraste do riscado no card selecionado').toBeGreaterThanOrEqual(4.5);
    expect(cFinal, 'contraste do preço cobrado no card selecionado').toBeGreaterThanOrEqual(4.5);
  });
});

test.describe('landing — CIT-22: riscado e cobrado não dependem só de cor (CA14)', { tag: '@CIT-22' }, () => {
  test('o riscado é anunciado com "de"/"por" em texto e a cascata usa o sinal "−" (U+2212), não hífen', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.evaluate(() => { updateQty('5gb', '2'); setBilling('annual'); });

    await expect(page.locator('#card5 .atc-unit-tabela .sr-only')).toHaveText('de ');
    await expect(page.locator('#unitPrice5 .sr-only')).toHaveText('por ');
    const disc = /** @type {string} */ (await page.locator('#csSummaryLines .cs-disc').first().textContent());
    expect(disc).toContain('−15% contratação −R$');
    expect(disc.replace(/−/g, '')).not.toContain('-R$');
  });
});

test.describe('landing — CIT-22: resumo sticky só acima de 960px, sem transbordo horizontal (CA15)', { tag: '@CIT-22' }, () => {
  /** @type {[number, number][]} */
  const LARGURAS = [[360, 740], [412, 839], [961, 900], [1280, 900]];

  for (const [largura, altura] of LARGURAS) {
    test(`${largura}x${altura}, 3 tipos no mensal e no anual: .calc-summary sticky só acima de 960px, sem transbordo`, async ({ page, erros }) => {
      await page.setViewportSize({ width: largura, height: altura });
      await page.goto('index.html');
      await page.evaluate(() => { updateQty('5gb', '5'); updateQty('25gb', '1'); updateQty('50gb', '1'); });

      for (const anual of [false, true]) {
        if (anual) await page.evaluate(() => setBilling('annual'));
        const posicao = await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('.calc-summary'))).position);
        const esperado = largura <= 960 ? 'static' : 'sticky';
        expect(posicao, `${largura}x${altura}, ${anual ? 'anual' : 'mensal'}: position do .calc-summary`).toBe(esperado);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${largura}x${altura}, ${anual ? 'anual' : 'mensal'}: rolagem horizontal do documento`).toBeLessThanOrEqual(0);
      }
    });
  }

  for (const largura of [360, 412]) {
    test(`largura ${largura}px, mensal com 5×5GB: #card5 sem transbordo horizontal`, async ({ page, erros }) => {
      await page.setViewportSize({ width: largura, height: 740 });
      await page.goto('index.html');
      await page.evaluate(() => updateQty('5gb', '5'));
      const m = await page.evaluate(() => {
        const el = /** @type {HTMLElement} */ (document.getElementById('card5'));
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      expect(m.scrollWidth, `largura ${largura}px: #card5 transborda`).toBeLessThanOrEqual(m.clientWidth);
    });
  }
});

test.describe('landing — CIT-22: fonte única de preços, sem valor fixo no HTML bruto (CA17)', { tag: '@CIT-22' }, () => {
  test('3 .account-type-card, sem preço fixo fora de PRECOS, sem chaves antigas', async ({ page, baseURL, erros }) => {
    await page.goto('index.html');

    const resp = await page.request.get(new URL('index.html', baseURL).toString());
    const html = await resp.text();
    const resultado = await page.evaluate((rawHtml) => {
      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      const contadores = { '.account-type-card': doc.querySelectorAll('.account-type-card').length };
      const regex = /\d+,\d\d/g;
      const achados = [];
      doc.querySelectorAll('.account-type-card').forEach(el => {
        const casados = (el.textContent.match(regex) || []).filter(v => v !== '0,00');
        if (casados.length) achados.push(`.account-type-card#${el.id || ''}: ${casados.join(',')}`);
      });
      return { contadores, achados };
    }, html);

    expect(resultado.contadores, 'contagem de .account-type-card').toEqual({ '.account-type-card': 3 });
    expect(resultado.achados, 'preço fixo no HTML bruto da landing (sem executar JS)').toEqual([]);

    const chaves = await page.evaluate(() => ({
      accountTypesComBase: Object.values(ACCOUNT_TYPES).some(d => 'base' in d),
      elementosComDataBase: document.querySelectorAll('[data-base]').length,
    }));
    expect(chaves).toEqual({ accountTypesComBase: false, elementosComDataBase: 0 });
  });
});

test.describe('landing — CIT-22: paridade da cascata de preços entre landing e checkout (CA7)', { tag: '@CIT-22' }, () => {
  /**
   * Lê, na página atual, o resultado de cascataCentavos/PRECOS.contas numa grade tipo × qtd (0..12) × ciclo.
   * cascataCentavos e PRECOS vêm de assets/precos.js, carregado por ambas as páginas — o mesmo helper
   * roda em cada uma para comparar por igualdade profunda.
   * @param {import('@playwright/test').Page} page
   */
  async function gradeCascata(page) {
    return page.evaluate(() => {
      const tipos = ['5gb', '25gb', '50gb'];
      const grade = [];
      for (const tipo of tipos) {
        for (let qty = 0; qty <= 12; qty++) {
          for (const anual of [false, true]) {
            grade.push(cascataCentavos(PRECOS.contas[tipo], qty, { conta: true, anual }));
          }
        }
      }
      return { grade, contas: PRECOS.contas };
    });
  }

  test('cascataCentavos e PRECOS.contas são idênticos entre landing e checkout, numa grade tipo × qtd 0..12 × ciclo', async ({ page, erros }) => {
    await page.goto('index.html');
    const daLanding = await gradeCascata(page);

    await page.goto('checkout.html');
    const doCheckout = await gradeCascata(page);

    expect(doCheckout, 'cascataCentavos/PRECOS.contas do checkout deveriam ser idênticos aos da landing').toEqual(daLanding);
  });

  test('index.html e checkout.html carregam o mesmo assets/precos.js?v=', async ({ page, erros }) => {
    // O Vite reescreve "assets/..." para "/citmail/assets/..." só ao servir index.html (não checkout.html,
    // caminho pré-existente e fora do escopo desta história); por isso a comparação usa só o "?v=", não o
    // atributo src inteiro.
    await page.goto('index.html');
    const srcLanding = await page.evaluate(() => document.querySelector('script[src*="precos.js"]')?.getAttribute('src'));
    expect(srcLanding).toMatch(/\bassets\/precos\.js\?v=\d+$/);
    const vLanding = srcLanding.match(/\?v=(\d+)$/)[1];

    await page.goto('checkout.html');
    const srcCheckout = await page.evaluate(() => document.querySelector('script[src*="precos.js"]')?.getAttribute('src'));
    expect(srcCheckout).toMatch(/\bassets\/precos\.js\?v=\d+$/);
    const vCheckout = srcCheckout.match(/\?v=(\d+)$/)[1];

    expect(vCheckout, 'checkout.html deveria carregar o mesmo ?v= de assets/precos.js que a landing').toBe(vLanding);
  });
});

// CIT-22: guarda de carga quando assets/precos.js não carrega. Este teste ESPERA erro de rede/console
// de propósito (aborta o script e confere o aviso), por isso não usa a fixture `erros` — usa o `test`
// puro do Playwright (testSemErros), que não falha ao ver erros registrados.
testSemErros.describe('landing — CIT-22: guarda quando assets/precos.js não carrega', { tag: '@CIT-22' }, () => {
  testSemErros('mostra o aviso "Não foi possível carregar os preços. Recarregue a página." no lugar da calculadora', async ({ page }) => {
    await page.route('**/assets/precos.js*', route => route.abort());
    await page.goto('index.html');
    await expect(page.locator('#pricing .calc-wrapper .discount-info[role="alert"]')).toHaveText(
      'Não foi possível carregar os preços. Recarregue a página.'
    );
  });

  // CIT-22, revisão 2º ciclo: só a calculadora (precosOk) sai cedo; header, menu, FAQ e fade-in continuam
  // funcionando sem assets/precos.js. Erros de rede/console do recurso abortado são esperados (por isso
  // testSemErros, sem a fixture `erros`); o que este teste garante é que não há pageerror (script não
  // capturado) além do aviso — sinal de que a guarda não deixou nenhuma outra função sem proteção.
  testSemErros('sem assets/precos.js, o resto da página (fade-in, FAQ e menu mobile) continua funcionando, sem pageerror', async ({ page }) => {
    const pageerrors = [];
    page.on('pageerror', err => pageerrors.push(err.message));
    await page.route('**/assets/precos.js*', route => route.abort());
    await page.setViewportSize({ width: 412, height: 839 }); // largura mobile: exibe o nav-toggle (@media max-width: 900px)
    await page.goto('index.html');
    await expect(page.locator('#pricing .calc-wrapper .discount-info[role="alert"]')).toHaveText(
      'Não foi possível carregar os preços. Recarregue a página.'
    );

    // fade-in: rolar até #features aplica "visible" (IntersectionObserver, independente de precosOk)
    const featuresHeader = page.locator('#features .section-header');
    await featuresHeader.scrollIntoViewIfNeeded();
    await expect(featuresHeader).toHaveClass(/visible/);

    // FAQ: clicar numa pergunta abre a resposta (toggleFaq não depende de precosOk)
    const primeiroFaq = page.locator('.faq-item').first();
    await primeiroFaq.locator('.faq-question').click();
    await expect(primeiroFaq).toHaveClass(/open/);

    // menu mobile: abre ao clicar no botão (setNavOpen não depende de precosOk)
    await page.locator('#navToggle').click();
    await expect(page.locator('#header')).toHaveClass(/nav-mobile-open/);

    // toggle de ciclo removido (sem preços não teria efeito); chamadas diretas saem cedo sem erro
    await expect(page.locator('#pricing .billing-toggle')).toHaveCount(0);
    await page.evaluate(() => { setBilling('annual'); toggleBilling(); changeQty('5gb', 1); updateQty('25gb', '3'); recalcAll(); });

    expect(pageerrors, 'não deveria haver pageerror com a guarda de carga').toEqual([]);
  });
});

// ===================================================================================================
// CIT-50: textos, contas e FAQ da landing coerentes com o lançamento
// ===================================================================================================

/** Normaliza espaços (o `<br/>` do h2 vira quebra de linha no innerText). */
const plano = (/** @type {string} */ t) => t.replace(/\s+/g, ' ').trim();

test.describe('landing — CIT-50: promessas do lançamento', { tag: '@CIT-50' }, () => {
  test('nenhum termo proibido no texto visível, na meta ou em aria-label/alt/title (acordeão fechado)', async ({ page, erros }) => {
    await page.goto('index.html');
    const texto = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const attrs = [...document.querySelectorAll('[aria-label], [alt], [title]')].flatMap(el =>
        ['aria-label', 'alt', 'title'].map(a => el.getAttribute(a) || ''));
      return [document.body.innerText, meta, ...attrs].join('\n');
    });
    for (const termo of TERMOS_PROIBIDOS) {
      expect(texto, `termo proibido na landing: ${termo.source}`).not.toMatch(termo);
    }
  });

  test('seção de depoimentos não existe e o fonte não cita os três nomes antigos', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#testimonials')).toHaveCount(0);
    const fonte = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const nome of ['Ricardo S.', 'Ana M.', 'Fábio O.']) {
      expect(fonte, `nome de depoimento no index.html: ${nome}`).not.toContain(nome);
    }
  });

  test('Recursos tem os 5 cards na ordem', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#features .feature-card h3')).toHaveText(FEATURE_TITULOS);
  });

  test('subtítulo do Marketplace é o final', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#marketplace .section-header p')).toHaveText(MARKETPLACE_SUBTITULO);
  });

  test('cards Domínio Próprio e Painel de Controle têm a descrição final', async ({ page, erros }) => {
    await page.goto('index.html');
    const cards = page.locator('#features .feature-card');
    for (const [i, texto] of Object.entries(FEATURE_DESCRICOES)) {
      await expect(cards.nth(Number(i)).locator('p'), `card ${Number(i) + 1} de Recursos`).toHaveText(texto);
    }
  });

  test('nota de domínio da caixa "Incluso" é a final', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.included-box p')).toHaveText(NOTA_DOMINIO_INCLUSO);
  });

  test('subtítulo do painel do cliente é o final', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#painel-preview h2 + p')).toHaveText(PAINEL_SUBTITULO);
  });

  test('Marketplace tem os 3 cards, com título e selo', async ({ page, erros }) => {
    await page.goto('index.html');
    const cards = page.locator('#marketplace .marketplace-card');
    await expect(cards).toHaveCount(MARKETPLACE_CARDS.length);
    await expect(cards.locator('h3')).toHaveText(MARKETPLACE_CARDS.map(c => c.titulo));
    await expect(cards.locator('.badge')).toHaveText(MARKETPLACE_CARDS.map(c => c.badge));
  });

  test('"Incluso em todas as contas" tem os 6 itens na ordem', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.included-box .included-item')).toHaveText(INCLUSO_ITENS);
  });

  test('lista do painel do cliente tem os 5 itens na ordem', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#painel-preview .painel-features-list li')).toHaveText(PAINEL_ITENS);
  });

  test('card de 50 GB não tem selo de IA e mostra a linha de armazenamento final', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#card50 .atc-ai-badge')).toHaveCount(0);
    await expect(page.locator('#card50 .atc-storage')).toHaveText(CARD50_STORAGE);
  });

  test('2º e 3º indicadores do hero têm o texto final', async ({ page, erros }) => {
    await page.goto('index.html');
    const stats = page.locator('.hero-stat');
    await expect(stats.nth(1).locator('.number')).toHaveText('99,5%');
    await expect(stats.nth(1).locator('.label')).toHaveText('Meta de disponibilidade');
    await expect(stats.nth(2).locator('.number')).toHaveText('5 min');
    await expect(stats.nth(2).locator('.label')).toHaveText('Ativação após o pagamento');
  });

  test('faixa de confiança tem os 4 itens exatos', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.trust-bar-inner .trust-item')).toHaveText(TRUST_ITEMS);
  });

  test('meta description é a final, sem preço', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', META_DESCRIPTION);
  });

  test('título e texto da busca de domínio são os finais', async ({ page, erros }) => {
    await page.goto('index.html');
    expect(plano(await page.locator('#domain-search h2').innerText())).toBe(BUSCA_H2);
    await expect(page.locator('#domain-search .domain-search-inner > p').first()).toHaveText(BUSCA_P);
  });

  test('busca por domínio fictício mostra "parece disponível" com o link Contratar', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.locator('#domainInput').fill('empresaficticia50');
    await page.locator('#domainCheckBtn').click();
    const livre = page.locator('#domainResult .domain-available');
    await expect(livre).toContainText(BUSCA_LIVRE);
    await expect(livre.locator('a')).toHaveText('Contratar →');
    await expect(livre.locator('a')).toHaveAttribute('href', '#pricing');
  });

  test('busca por "citmail" mostra "parece já estar registrado"', async ({ page, erros }) => {
    await page.goto('index.html');
    await page.locator('#domainInput').fill('citmail');
    await page.locator('#domainCheckBtn').click();
    await expect(page.locator('#domainResult .domain-taken')).toContainText(BUSCA_OCUPADO);
  });
});

test.describe('landing — CIT-50: FAQ e prazos', { tag: '@CIT-50' }, () => {
  test('FAQ tem 8 perguntas', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#faq .faq-item')).toHaveCount(FAQ_LITERAIS.length);
  });

  test('perguntas do FAQ são as finais, na ordem', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#faq .faq-question span')).toHaveText(FAQ_LITERAIS.map(([q]) => q));
  });

  test('respostas do FAQ são as finais, na ordem', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('#faq .faq-answer p')).toHaveText(FAQ_LITERAIS.map(([, r]) => r));
  });

  test('nota de cancelamento do resumo é a final', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.cs-feature-nota')).toHaveText(NOTA_CANCELAMENTO);
  });

  test('passos 2 a 4 de Como funciona têm o texto final', async ({ page, erros }) => {
    await page.goto('index.html');
    const textos = page.locator('#how-it-works .step-card p');
    for (const i of [1, 2, 3]) {
      await expect(textos.nth(i), `passo ${i + 1}`).toHaveText(/** @type {string} */ (PASSOS_COMO_FUNCIONA[i]));
    }
  });
});

test.describe('landing — CIT-50: contas 4→5', { tag: '@CIT-50' }, () => {
  /** @param {number} c centavos */
  const reais = c => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
  const ID_POR_TIPO = { '5gb': '5', '25gb': '25', '50gb': '50' };

  for (const tipo of /** @type {const} */ (['5gb', '25gb', '50gb'])) {
    for (const anual of [false, true]) {
      test(`${tipo} ${anual ? 'anual' : 'mensal'}: subtotal e total com 4 e depois 5 contas batem com PRECOS.contas`, async ({ page, erros }) => {
        await page.goto('index.html');
        // preço de lista lido da página; a conta é refeita aqui, sem usar o landing.js
        const atual = await page.evaluate(t => PRECOS.contas[t], tipo);
        const n = ID_POR_TIPO[tipo];
        await page.locator(anual ? '#toggleAnnual' : '#toggleMonthly').click();

        for (const qtd of [4, 5]) {
          const pct = anual ? 20 : (qtd >= 5 ? 5 : 0);
          const total = qtd * Math.round(atual * (100 - pct) / 100);
          const input = page.locator(`#qty${n}`);
          await input.fill(String(qtd));
          await input.press('Tab');
          await expect(page.locator(`#sub${n}`), `${qtd}×${tipo} #sub${n}`).toHaveText(`${reais(total)}/mês`);
          await expect(page.locator('#csTotal'), `${qtd}×${tipo} #csTotal`).toHaveText(reais(total));
        }
      });
    }
  }
});

test.describe('landing — CIT-50: rodapé e links', { tag: '@CIT-50' }, () => {
  /**
   * Quantidade de `a[href="#"]` na landing, com o estado no rótulo da falha.
   * @param {import('@playwright/test').Page} page
   * @param {string} estado
   */
  async function semHrefVazio(page, estado) {
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href="#"]')].map(a => a.outerHTML.slice(0, 120)));
    expect(links, `a[href="#"] ${estado}`).toEqual([]);
  }

  test('rodapé não tem os links Sobre nós, Blog, Parceiros, Privacidade e Termos', async ({ page, erros }) => {
    await page.goto('index.html');
    const textos = (await page.locator('footer a').allInnerTexts()).map(t => t.trim());
    for (const removido of RODAPE_TEXTOS_REMOVIDOS) {
      expect(textos, `link do rodapé: ${removido}`).not.toContain(removido);
    }
  });

  test('rodapé não tem redes sociais', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.footer-social')).toHaveCount(0);
  });

  test('linha legal do rodapé tem razão social e CNPJ finais, e o fonte não tem CNPJ provisório', async ({ page, erros }) => {
    await page.goto('index.html');
    await expect(page.locator('.footer-bottom p')).toHaveText(RODAPE_LEGAL);
    const fonte = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(fonte).not.toContain('XX.XXX.XXX');
  });

  test('coluna Suporte do rodapé tem os 3 links finais', async ({ page, erros }) => {
    await page.goto('index.html');
    const links = page.locator('footer .footer-col').filter({ has: page.locator('h4', { hasText: /^Suporte$/ }) }).locator('a');
    await expect(links).toHaveText(RODAPE_SUPORTE.map(l => l.texto));
    for (let i = 0; i < RODAPE_SUPORTE.length; i++) {
      await expect(links.nth(i)).toHaveAttribute('href', RODAPE_SUPORTE[i].href);
    }
  });

  test('os dois logos têm href="#hero" e aria-label="CITMail"', async ({ page, erros }) => {
    await page.goto('index.html');
    const logos = page.locator('.nav-logo');
    await expect(logos).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(logos.nth(i)).toHaveAttribute('href', '#hero');
      await expect(logos.nth(i)).toHaveAttribute('aria-label', 'CITMail');
    }
  });

  test('nenhum a[href="#"] na carga, com carrinho vazio, com 1×25GB e depois da busca de domínio', async ({ page, erros }) => {
    await page.goto('index.html');
    await semHrefVazio(page, 'na carga');

    const cta = page.locator('#calcCtaBtn');
    const qty25 = page.locator('#qty25');
    await qty25.fill('1');
    await qty25.press('Tab');
    await expect(cta).toHaveAttribute('href', /checkout\.html\?/);
    await semHrefVazio(page, 'com 1×25GB');

    await qty25.fill('0');
    await qty25.press('Tab');
    await expect(cta).toHaveAttribute('role', 'link');
    await semHrefVazio(page, 'com o carrinho vazio de novo');

    await page.locator('#domainInput').fill('empresaficticia50');
    await page.locator('#domainCheckBtn').click();
    await expect(page.locator('#domainResult .domain-available')).toBeVisible();
    await semHrefVazio(page, 'depois da busca de domínio');
  });

  test('CTA com carrinho vazio não tem href e se anuncia como link indisponível', async ({ page, erros }) => {
    await page.goto('index.html');
    const cta = page.locator('#calcCtaBtn');
    await expect(cta).not.toHaveAttribute('href', /.*/);
    await expect(cta).toHaveAttribute('role', 'link');
    await expect(cta).toHaveAttribute('aria-disabled', 'true');
  });

  test('CTA com 1×25GB tem href do checkout e perde role e aria-disabled', async ({ page, erros }) => {
    await page.goto('index.html');
    const qty25 = page.locator('#qty25');
    await qty25.fill('1');
    await qty25.press('Tab');
    const cta = page.locator('#calcCtaBtn');
    await expect(cta).toHaveAttribute('href', /checkout\.html\?/);
    await expect(cta).not.toHaveAttribute('role', /.*/);
    await expect(cta).not.toHaveAttribute('aria-disabled', /.*/);
  });

  test('CTA volta a ficar sem href, com role e aria-disabled, ao zerar as contas', async ({ page, erros }) => {
    await page.goto('index.html');
    const qty25 = page.locator('#qty25');
    await qty25.fill('1');
    await qty25.press('Tab');
    await expect(page.locator('#calcCtaBtn')).toHaveAttribute('href', /checkout\.html\?/);
    await qty25.fill('0');
    await qty25.press('Tab');
    const cta = page.locator('#calcCtaBtn');
    await expect(cta).not.toHaveAttribute('href', /.*/);
    await expect(cta).toHaveAttribute('role', 'link');
    await expect(cta).toHaveAttribute('aria-disabled', 'true');
  });

  test('fontes index.html e assets/landing.js não atribuem "#" a href', async ({ page, erros }) => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const js = readFileSync(new URL('../assets/landing.js', import.meta.url), 'utf8');
    expect(html).not.toMatch(/href\s*=\s*["']#["']/);
    // atribuição a href com '#' em qualquer posição (inclusive ternário): `x.href = c ? '#' : ...`
    expect(js, "atribuição a href com '#'").not.toMatch(/\bhref\s*=[^;]*['"`]#['"`]/);
    // setAttribute('href', ... '#' ...), inclusive ternário
    expect(js, "setAttribute('href') com '#'").not.toMatch(/setAttribute\(\s*['"]href['"]\s*,[^;]*['"`]#['"`]/);
  });
});

test.describe('landing — CIT-50: mobile', { tag: '@CIT-50' }, () => {
  for (const largura of [320, 375]) {
    test(`${largura}px: documento e contêineres sem rolagem horizontal, na carga e com 5 contas de cada tipo`, async ({ page, erros }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'CA5 só no perfil mobile');
      await page.setViewportSize({ width: largura, height: 800 });
      await page.goto('index.html');

      const medir = () => page.evaluate(() => {
        const sels = ['.hero-stats', '.trust-bar-inner', '.included-box', '.footer-bottom'];
        const doc = document.documentElement;
        return {
          documento: doc.scrollWidth - doc.clientWidth,
          conteineres: sels.map(sel => {
            const el = /** @type {HTMLElement} */ (document.querySelector(sel));
            return { sel, excesso: el.scrollWidth - el.clientWidth };
          }),
        };
      });
      const confere = (/** @type {Awaited<ReturnType<typeof medir>>} */ m, /** @type {string} */ estado) => {
        expect(m.documento, `documento transborda ${estado}`).toBeLessThanOrEqual(0);
        for (const c of m.conteineres) expect(c.excesso, `${c.sel} transborda ${estado}`).toBeLessThanOrEqual(0);
      };

      confere(await medir(), 'na carga');
      await page.evaluate(() => { updateQty('5gb', '5'); updateQty('25gb', '5'); updateQty('50gb', '5'); });
      confere(await medir(), 'com 5 contas de cada tipo');
    });

    test(`${largura}px: cada resposta do FAQ aberta sem corte nem transbordo horizontal`, async ({ page, erros }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'CA5 só no perfil mobile');
      await page.setViewportSize({ width: largura, height: 800 });
      await page.goto('index.html');

      const itens = page.locator('#faq .faq-item');
      const total = await itens.count();
      expect(total).toBe(FAQ_LITERAIS.length);

      for (let i = 0; i < total; i++) {
        const item = itens.nth(i);
        await item.locator('.faq-question').click(); // o acordeão fecha as outras
        await expect(item).toHaveClass(/open/);
        const resposta = item.locator('.faq-answer');
        const p = resposta.locator('p');

        // espera o fim da transição: a altura do .faq-answer estabiliza
        let anterior = -1;
        await expect.poll(async () => {
          const h = await resposta.evaluate(el => el.clientHeight);
          const estavel = h === anterior && h > 0;
          anterior = h;
          return estavel;
        }, { message: `transição do FAQ ${i + 1} não estabilizou`, intervals: [100, 100, 100, 200, 300], timeout: 5000 }).toBe(true);

        const m = await page.evaluate(([idx]) => {
          const it = document.querySelectorAll('#faq .faq-item')[idx];
          const ans = /** @type {HTMLElement} */ (it.querySelector('.faq-answer'));
          const par = /** @type {HTMLElement} */ (ans.querySelector('p'));
          const doc = document.documentElement;
          return {
            larguraP: par.scrollWidth - par.clientWidth,
            alturaP: par.scrollHeight - ans.clientHeight,
            documento: doc.scrollWidth - doc.clientWidth,
          };
        }, [i]);
        expect(m.larguraP, `FAQ ${i + 1}: texto estoura a largura`).toBeLessThanOrEqual(0);
        expect(m.alturaP, `FAQ ${i + 1}: resposta cortada pelo max-height`).toBeLessThanOrEqual(0);
        expect(m.documento, `FAQ ${i + 1}: documento com rolagem horizontal`).toBeLessThanOrEqual(0);
        await expect(p).toBeVisible();
      }
    });
  }
});
