import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('CA4: journald-namespace.conf define Storage, MaxRetentionSec, MaxFileSec e SystemMaxUse na seção [Journal]', async () => {
  const caminho = fileURLToPath(new URL('../deploy/journald-namespace.conf', import.meta.url));
  const conteudo = await readFile(caminho, 'utf8');
  const linhas = conteudo.split('\n').map((linha) => linha.trim());

  const indiceSecao = linhas.indexOf('[Journal]');
  assert.ok(indiceSecao !== -1, 'era esperada a seção [Journal]');

  const linhasDaSecao = linhas.slice(indiceSecao + 1).filter((linha) => linha && !linha.startsWith('['));

  for (const esperada of ['Storage=persistent', 'MaxRetentionSec=29day', 'MaxFileSec=1day', 'SystemMaxUse=1G']) {
    assert.ok(linhasDaSecao.includes(esperada), `era esperada a linha "${esperada}" na seção [Journal]`);
  }
});
