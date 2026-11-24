// CIT-77, CA6 (unitários): dias úteis e datas locais de America/Sao_Paulo. Início exclusivo,
// fim inclusivo, segunda a sexta, sem feriados; a data local manda, não a UTC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dataLocal, diasUteisEntre, ehDiaUtil, somarDias } from '../src/dominios/dias-uteis.js'

test('CA6: de segunda a segunda seguinte são 5 dias úteis', () => {
  assert.equal(diasUteisEntre('2026-11-30T13:00:00Z', '2026-12-07T13:00:00Z'), 5)
})

test('CA6: de sexta 23h59 local a sábado são 0 dias úteis', () => {
  // sexta 04/12 23h59 local = sábado 05/12 02h59Z; sábado 05/12 10h local = 13h Z
  assert.equal(diasUteisEntre('2026-12-05T02:59:00Z', '2026-12-05T13:00:00Z'), 0)
})

test('CA6: a data local manda, não a UTC (domingo 23h30 local a segunda é 1 dia útil)', () => {
  assert.equal(diasUteisEntre('2026-11-30T02:30:00Z', '2026-11-30T13:00:00Z'), 1)
})

test('CA6: a virada de mês conta (27/11 a 02/12 são 3 dias úteis)', () => {
  assert.equal(diasUteisEntre('2026-11-27T13:00:00Z', '2026-12-02T13:00:00Z'), 3)
})

test('CA6: no mesmo dia são 0 dias úteis', () => {
  assert.equal(diasUteisEntre('2026-11-30T12:00:00Z', '2026-11-30T20:00:00Z'), 0)
})

test('CA6: fim antes do início devolve 0', () => {
  assert.equal(diasUteisEntre('2026-12-07T13:00:00Z', '2026-11-30T13:00:00Z'), 0)
})

test('CA6: aceita Date, número e texto ISO', () => {
  const inicio = new Date('2026-11-30T13:00:00Z')
  assert.equal(diasUteisEntre(inicio, inicio.getTime() + 3 * 86400000), 3)
})

test('CA6: dataLocal devolve a data de America/Sao_Paulo', () => {
  assert.equal(dataLocal('2026-11-30T02:30:00Z'), '2026-11-29')
  assert.equal(dataLocal('2026-11-30T13:00:00Z'), '2026-11-30')
})

test('CA6: ehDiaUtil é verdadeiro de segunda a sexta e falso no fim de semana', () => {
  assert.deepEqual(
    ['2026-11-30', '2026-12-04', '2026-12-05', '2026-12-06'].map(ehDiaUtil),
    [true, true, false, false]
  )
})

test('CA6: somarDias soma e subtrai dias de calendário', () => {
  assert.equal(somarDias('2026-12-30', 3), '2027-01-02')
  assert.equal(somarDias('2026-03-01', -1), '2026-02-28')
})
