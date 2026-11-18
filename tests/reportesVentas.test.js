import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fechaLimaAUTC, siguienteDia, resumirVentas, validarVenta } from '../src/components/reportesVentasUtils.ts'

const base = () => ({
  atencionId: 'atencion-1', pagoId: 'pago-1',
  pago: { metodo: 'efectivo', importeCentimos: 5000, importe: 50, registradoEn: new Date('2026-11-17T15:00:00Z'), confirmadoPor: 'admin' },
  atencion: { estado: 'cerrada', pagoId: 'pago-1', metodoPago: 'efectivo', totalPagadoCentimos: 5000, totalCentimos: 5000, total: 50, mesaNumero: 4 },
  pedidos: [{ atencionId: 'atencion-1', totalCentimos: 5000, total: 50, items: [
    { productoId: 'pollo', nombre: 'Pollo', cantidad: 2, precioUnitarioCentimos: 2500, subtotalCentimos: 5000 },
  ] }],
})

test('valida una venta cerrada con pago canónico y líneas que cuadran', () => {
  const result = validarVenta(base())
  assert.equal(result.incidencias.length, 0)
  assert.equal(result.venta?.totalCentimos, 5000)
})

test('excluye importes de pago, atención o pedidos inconsistentes', () => {
  const wrongPayment = base(); wrongPayment.pago.importeCentimos = 4999
  assert.equal(validarVenta(wrongPayment).venta, undefined)
  const wrongOrder = base(); wrongOrder.pedidos[0].items[0].subtotalCentimos = 4999
  assert.equal(validarVenta(wrongOrder).venta, undefined)
  const wrongCanonical = base(); wrongCanonical.pagoId = 'pago-otro'
  assert.equal(validarVenta(wrongCanonical).venta, undefined)
  const malformedLegacyFallback = base(); malformedLegacyFallback.pago.importeCentimos = '5000'
  assert.equal(validarVenta(malformedLegacyFallback).venta, undefined)
})

test('comprueba importes redundantes y conserva documentos históricos solo en soles', () => {
  const matching = base()
  matching.pago.importe = 50
  assert.ok(validarVenta(matching).venta)
  const mismatch = base()
  mismatch.pago.importe = 50.01
  assert.equal(validarVenta(mismatch).venta, undefined)
  const legacy = base()
  delete legacy.pago.importeCentimos; delete legacy.atencion.totalCentimos; delete legacy.atencion.totalPagadoCentimos
  legacy.pago.importe = 50
  delete legacy.pedidos[0].totalCentimos
  delete legacy.pedidos[0].items[0].precioUnitarioCentimos
  delete legacy.pedidos[0].items[0].subtotalCentimos
  legacy.pedidos[0].items[0].precioUnitario = 25
  legacy.pedidos[0].items[0].subtotal = 50
  assert.ok(validarVenta(legacy).venta)
})

test('rechaza precio por cantidad y total de pedido que no cuadran', () => {
  const wrongUnit = base(); wrongUnit.pedidos[0].items[0].precioUnitarioCentimos = 2499
  assert.equal(validarVenta(wrongUnit).venta, undefined)
  const wrongOrderTotal = base(); wrongOrderTotal.pedidos[0].total = 49.99
  assert.equal(validarVenta(wrongOrderTotal).venta, undefined)
})

test('agrega efectivo, Yape y productos sin contar dos veces una atención', () => {
  const first = validarVenta(base()).venta
  const secondInput = base()
  secondInput.atencionId = 'atencion-2'; secondInput.pagoId = 'pago-2'
  secondInput.pago.metodo = 'yape'; secondInput.atencion.metodoPago = 'yape'
  secondInput.atencion.pagoId = 'pago-2'; secondInput.atencion.mesaNumero = 5
  secondInput.pedidos[0].atencionId = 'atencion-2'
  const second = validarVenta(secondInput).venta
  const summary = resumirVentas([first, second, first])
  assert.equal(summary.totalCentimos, 10000)
  assert.equal(summary.efectivoCentimos, 5000)
  assert.equal(summary.yapeCentimos, 5000)
  assert.equal(summary.cantidadVentas, 2)
  assert.equal(summary.ventasPorDia.length, 1)
  assert.equal(summary.ventasPorDia[0].totalCentimos, 10000)
  assert.equal(summary.productos[0].cantidad, 4)
  assert.equal(summary.incidencias.length, 1)
})

test('convierte fechas calendario de Lima a intervalo UTC [inicio, fin)', () => {
  assert.equal(fechaLimaAUTC('2026-11-17').toISOString(), '2026-11-17T05:00:00.000Z')
  assert.equal(fechaLimaAUTC(siguienteDia('2026-11-17')).toISOString(), '2026-11-18T05:00:00.000Z')
  assert.equal(siguienteDia('2026-12-31'), '2027-01-01')
})
