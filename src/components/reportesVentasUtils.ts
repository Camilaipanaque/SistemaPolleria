export type VentaValidada = {
  atencionId: string
  pagoId: string
  fecha: Date
  metodo: 'efectivo' | 'yape'
  totalCentimos: number
  mesaNumero: number | null
  pedidos: number
  lineas: Array<{ productoId: string; nombre: string; presentacion?: string; cantidad: number; precioUnitarioCentimos: number; subtotalCentimos: number }>
}

export type IncidenciaReporte = { atencionId: string; pagoId?: string; motivo: string }
type Registro = Record<string, unknown>

export function imprimirConFormato(formato: 'ticket' | 'a4'): void {
  const style = document.createElement('style')
  style.dataset.printFormat = 'true'
  style.textContent = formato === 'ticket'
    ? '@page{size:80mm auto;margin:4mm}'
    : '@page{size:A4 landscape;margin:12mm}'
  document.head.append(style)
  const limpiar = () => style.remove()
  window.addEventListener('afterprint', limpiar, { once: true })
  window.print()
  window.setTimeout(limpiar, 5000)
}

function esRegistro(value: unknown): value is Registro {
  return typeof value === 'object' && value !== null
}

export function fechaLimaHoy(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function desfaseZonaLima(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs
}

export function fechaLimaAUTC(fecha: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha)
  if (!match) throw new Error('Fecha inválida.')
  const [, year, month, day] = match
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day))
  const validar = new Date(target).toISOString().slice(0, 10)
  if (validar !== fecha) throw new Error('Fecha inválida.')
  let utc = target - desfaseZonaLima(target)
  utc = target - desfaseZonaLima(utc)
  return new Date(utc)
}

export function siguienteDia(fecha: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha)
  if (!match) throw new Error('Fecha inválida.')
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1))
  return next.toISOString().slice(0, 10)
}

export function aFecha(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (esRegistro(value)) {
    if (typeof value.toDate === 'function') {
      const date = (value.toDate as () => Date)()
      return date instanceof Date && Number.isFinite(date.getTime()) ? date : null
    }
    if (typeof value.toMillis === 'function') {
      const millis = (value.toMillis as () => number)()
      return Number.isFinite(millis) ? new Date(millis) : null
    }
  }
  return null
}

export function importeEnCentimos(data: Registro, campoCentimos: string, campoSoles: string): number | null {
  const tieneCentimos = Object.prototype.hasOwnProperty.call(data, campoCentimos)
  const tieneSoles = Object.prototype.hasOwnProperty.call(data, campoSoles)
  let cents: number | null = null
  if (tieneCentimos) {
    const value = data[campoCentimos]
    if (!Number.isSafeInteger(value)) return null
    cents = Number(value)
  }
  if (tieneSoles) {
    const soles = data[campoSoles]
    if (typeof soles !== 'number' || !Number.isFinite(soles)) return null
    const converted = Math.round((soles + Number.EPSILON) * 100)
    if (!Number.isSafeInteger(converted) || (cents !== null && cents !== converted)) return null
    cents = converted
  }
  return cents
}

export function validarVenta(input: {
  atencionId: string
  pagoId: string
  pago: Registro
  atencion: Registro
  pedidos: Registro[]
}): { venta?: VentaValidada; incidencias: IncidenciaReporte[] } {
  const { atencionId, pagoId, pago, atencion, pedidos } = input
  const cabecera = validarPagoAtencion(input)
  const incidencias = [...cabecera.incidencias]
  const fallar = (motivo: string) => incidencias.push({ atencionId, pagoId, motivo })
  const paymentDate = aFecha(pago.registradoEn)
  const totalPago = importeEnCentimos(pago, 'importeCentimos', 'importe')
  const totalAtencion = importeEnCentimos(atencion, 'totalCentimos', 'total')
  if (cabecera.incidencias.length) return { incidencias }

  let totalPedidos = 0
  const lineas: VentaValidada['lineas'] = []
  for (const [index, pedido] of pedidos.entries()) {
    if (pedido.atencionId !== atencionId) {
      fallar(`El pedido ${index + 1} referencia otra atención.`)
      continue
    }
    const items = pedido.items
    if (!Array.isArray(items) || items.length === 0) {
      fallar(`El pedido ${index + 1} no contiene líneas válidas.`)
      continue
    }
    let totalLineas = 0
    let pedidoValido = true
    for (const itemValue of items) {
      if (!esRegistro(itemValue)) { pedidoValido = false; continue }
      const item = itemValue
      const nombre = typeof item.nombre === 'string' ? item.nombre.trim() : ''
      const cantidad = item.cantidad
      const unit = importeEnCentimos(item, 'precioUnitarioCentimos', 'precioUnitario')
      const subtotal = importeEnCentimos(item, 'subtotalCentimos', 'subtotal')
      const productoId = typeof item.productoId === 'string' && item.productoId ? item.productoId : nombre
      const presentacion = item.presentacion
      if (!nombre || !Number.isSafeInteger(cantidad) || Number(cantidad) < 1 ||
          !Number.isSafeInteger(unit) || Number(unit) < 0 || !Number.isSafeInteger(subtotal) ||
          !Number.isSafeInteger(Number(unit) * Number(cantidad)) || Number(subtotal) !== Number(unit) * Number(cantidad) ||
          (presentacion !== undefined && (typeof presentacion !== 'string' || !presentacion.trim() || presentacion.length > 60))) {
        pedidoValido = false
        continue
      }
      totalLineas += Number(subtotal)
      if (!Number.isSafeInteger(totalLineas)) { pedidoValido = false; continue }
      lineas.push({ productoId, nombre, ...(typeof presentacion === 'string' ? { presentacion } : {}), cantidad: Number(cantidad),
        precioUnitarioCentimos: Number(unit), subtotalCentimos: Number(subtotal) })
    }
    const totalPedido = importeEnCentimos(pedido, 'totalCentimos', 'total')
    if (!pedidoValido || totalPedido === null || totalLineas !== totalPedido) {
      fallar(`Las líneas y el total del pedido ${index + 1} no coinciden.`)
      continue
    }
    totalPedidos += totalLineas
    if (!Number.isSafeInteger(totalPedidos)) fallar('La suma de pedidos supera el rango monetario seguro.')
  }
  if (totalPedidos !== totalAtencion) fallar('La suma de pedidos no coincide con el total de la atención.')

  if (incidencias.length || !paymentDate || totalPago === null || !['efectivo', 'yape'].includes(String(pago.metodo)))
    return { incidencias }

  return { incidencias, venta: {
    atencionId, pagoId, fecha: paymentDate, metodo: pago.metodo as 'efectivo' | 'yape',
    totalCentimos: totalPago, mesaNumero: typeof atencion.mesaNumero === 'number' ? atencion.mesaNumero : null,
    pedidos: pedidos.length, lineas,
  } }
}

export function validarPagoAtencion(input: {
  atencionId: string; pagoId: string; pago: Registro; atencion: Registro
}): { fecha: Date | null; totalCentimos: number | null; metodo: 'efectivo' | 'yape' | null; incidencias: IncidenciaReporte[] } {
  const { atencionId, pagoId, pago, atencion } = input
  const incidencias: IncidenciaReporte[] = []
  const fallar = (motivo: string) => incidencias.push({ atencionId, pagoId, motivo })
  const fecha = aFecha(pago.registradoEn)
  const pagoCentimos = importeEnCentimos(pago, 'importeCentimos', 'importe')
  const total = importeEnCentimos(atencion, 'totalCentimos', 'total')
  const pagado = Object.prototype.hasOwnProperty.call(atencion, 'totalPagadoCentimos')
    ? (Number.isSafeInteger(atencion.totalPagadoCentimos) ? Number(atencion.totalPagadoCentimos) : null)
    : total
  const metodo = pago.metodo === 'efectivo' || pago.metodo === 'yape' ? pago.metodo : null
  if (atencion.estado !== 'cerrada') fallar('La atención no está cerrada.')
  if (atencion.pagoId !== pagoId) fallar('El pago no coincide con el pagoId canónico de la atención.')
  if (!metodo || metodo !== atencion.metodoPago) fallar('El método del pago no coincide con el de la atención.')
  if (typeof pago.confirmadoPor !== 'string' || !pago.confirmadoPor) fallar('El pago no tiene un administrador confirmante válido.')
  if (!fecha) fallar('El pago no tiene una fecha registradoEn válida.')
  if (pagoCentimos === null || total === null || pagado === null || pagoCentimos < 0 ||
      pagoCentimos !== total || pagoCentimos !== pagado || !Number.isSafeInteger(pagoCentimos))
    fallar('Los importes del pago, el total pagado y el total de la atención no coinciden.')
  return { fecha, totalCentimos: pagoCentimos, metodo, incidencias }
}

export function resumirVentas(ventas: VentaValidada[]): {
  totalCentimos: number; efectivoCentimos: number; yapeCentimos: number; cantidadVentas: number;
  ventasPorDia: Array<{ fecha: string; cantidadVentas: number; totalCentimos: number; efectivoCentimos: number; yapeCentimos: number }>
  productos: Array<{ productoId: string; nombre: string; presentacion?: string; cantidad: number; subtotalCentimos: number }>
  incidencias: IncidenciaReporte[]
} {
  let totalCentimos = 0, efectivoCentimos = 0, yapeCentimos = 0
  const vistos = new Set<string>()
  const productos = new Map<string, { productoId: string; nombre: string; presentacion?: string; cantidad: number; subtotalCentimos: number }>()
  const dias = new Map<string, { fecha: string; cantidadVentas: number; totalCentimos: number; efectivoCentimos: number; yapeCentimos: number }>()
  const incidencias: IncidenciaReporte[] = []
  let cantidadVentas = 0
  for (const venta of ventas) {
    if (vistos.has(venta.atencionId)) {
      incidencias.push({ atencionId: venta.atencionId, pagoId: venta.pagoId, motivo: 'Venta duplicada; solo se cuenta una vez.' })
      continue
    }
    const nextTotal = totalCentimos + venta.totalCentimos
    const nextMetodo = venta.metodo === 'efectivo' ? efectivoCentimos + venta.totalCentimos : yapeCentimos + venta.totalCentimos
    const claveProducto = (linea: VentaValidada['lineas'][number]) => JSON.stringify([linea.productoId, linea.presentacion ?? ''])
    const productosPrevios = venta.lineas.map((linea) => productos.get(claveProducto(linea)))
    const overflow = !Number.isSafeInteger(nextTotal) || !Number.isSafeInteger(nextMetodo) || venta.lineas.some((linea, i) =>
      !Number.isSafeInteger((productosPrevios[i]?.cantidad ?? 0) + linea.cantidad) ||
      !Number.isSafeInteger((productosPrevios[i]?.subtotalCentimos ?? 0) + linea.subtotalCentimos))
    if (overflow) {
      incidencias.push({ atencionId: venta.atencionId, pagoId: venta.pagoId, motivo: 'La suma excede el rango monetario seguro; la venta se excluyó.' })
      continue
    }
    vistos.add(venta.atencionId)
    cantidadVentas += 1
    totalCentimos = nextTotal
    if (venta.metodo === 'efectivo') efectivoCentimos = nextMetodo
    else yapeCentimos = nextMetodo
    const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(venta.fecha)
    const dateValue = (type: string) => dateParts.find((part) => part.type === type)?.value ?? ''
    const fechaDia = `${dateValue('year')}-${dateValue('month')}-${dateValue('day')}`
    const dia = dias.get(fechaDia) ?? { fecha: fechaDia, cantidadVentas: 0, totalCentimos: 0, efectivoCentimos: 0, yapeCentimos: 0 }
    dia.cantidadVentas += 1
    dia.totalCentimos += venta.totalCentimos
    if (venta.metodo === 'efectivo') dia.efectivoCentimos += venta.totalCentimos
    else dia.yapeCentimos += venta.totalCentimos
    dias.set(fechaDia, dia)
    for (const linea of venta.lineas) {
      const clave = claveProducto(linea)
      const current = productos.get(clave) ?? { productoId: linea.productoId, nombre: linea.nombre,
        ...(linea.presentacion ? { presentacion: linea.presentacion } : {}), cantidad: 0, subtotalCentimos: 0 }
      current.cantidad += linea.cantidad
      current.subtotalCentimos += linea.subtotalCentimos
      productos.set(clave, current)
    }
  }
  return { totalCentimos, efectivoCentimos, yapeCentimos, cantidadVentas,
    ventasPorDia: [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)),
    productos: [...productos.values()].sort((a, b) => b.cantidad - a.cantidad || b.subtotalCentimos - a.subtotalCentimos || a.nombre.localeCompare(b.nombre, 'es')),
    incidencias }
}
