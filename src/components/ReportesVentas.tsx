import { useState, type FormEvent } from 'react'
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import {
  fechaLimaAUTC,
  imprimirConFormato,
  fechaLimaHoy,
  siguienteDia,
  resumirVentas,
  validarPagoAtencion,
  validarVenta,
  type IncidenciaReporte,
  type VentaValidada,
} from './reportesVentasUtils'
import './ReportesVentas.css'

const LIMITE_DIAS = 31
const PAGINA_CONSULTA = 50
const LIMITE_PAGOS = 200
const LIMITE_PEDIDOS = 1200
const TAMANO_PAGINA_TABLA = 20

type Registro = Record<string, unknown>
type PagoCandidato = { id: string; atencionId: string; pago: Registro }
type Reporte = ReturnType<typeof resumirVentas> & { ventas: VentaValidada[]; desde: string; hasta: string }

function ReportesVentas({ usuarioId }: { usuarioId: string }) {
  const hoy = fechaLimaHoy()
  const [desde, setDesde] = useState(hoy)
  const [hasta, setHasta] = useState(hoy)
  const [reporte, setReporte] = useState<Reporte | null>(null)
  const [incidencias, setIncidencias] = useState<IncidenciaReporte[]>([])
  const [error, setError] = useState('')
  const [cargando, setCargando] = useState(false)
  const [pagina, setPagina] = useState(0)

  function limpiar() {
    setReporte(null); setIncidencias([]); setPagina(0)
  }

  async function generarReporte(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(''); limpiar()
    if (auth.currentUser?.uid !== usuarioId) {
      setError('La sesión actual no corresponde al administrador autenticado.')
      return
    }
    const inicioDia = Date.parse(`${desde}T00:00:00Z`)
    const finDia = Date.parse(`${hasta}T00:00:00Z`)
    const dias = (finDia - inicioDia) / 86400000 + 1
    if (!Number.isFinite(dias) || dias < 1) { setError('El rango de fechas no es válido.'); return }
    if (dias > LIMITE_DIAS) { setError(`El rango máximo es de ${LIMITE_DIAS} días para controlar lecturas. Acota las fechas.`); return }

    setCargando(true)
    const incidenciasLocales: IncidenciaReporte[] = []
    try {
      const inicio = fechaLimaAUTC(desde)
      const finExclusivo = fechaLimaAUTC(siguienteDia(hasta))
      const pagos: PagoCandidato[] = []
      let cursor: QueryDocumentSnapshot<DocumentData> | null = null
      while (true) {
        const base = [
          where('registradoEn', '>=', inicio),
          where('registradoEn', '<', finExclusivo),
          orderBy('registradoEn', 'asc'),
        ]
        const consulta: Query<DocumentData> = query(
          collectionGroup(db, 'pagos'),
          ...base,
          ...(cursor ? [startAfter(cursor)] : []),
          limit(PAGINA_CONSULTA),
        )
        const paginaPagos: QuerySnapshot<DocumentData> = await getDocs(consulta)
        if (pagos.length + paginaPagos.size > LIMITE_PAGOS) {
          throw new Error(`El rango supera el límite de ${LIMITE_PAGOS} pagos por reporte. Acota las fechas.`)
        }
        for (const pagoDoc of paginaPagos.docs) {
          const atencionRef = pagoDoc.ref.parent.parent
          if (!atencionRef || atencionRef.parent.id !== 'atenciones') {
            incidenciasLocales.push({ atencionId: '—', pagoId: pagoDoc.id, motivo: 'El pago no está dentro de la ruta de atenciones esperada; se excluyó.' })
            continue
          }
          pagos.push({ id: pagoDoc.id, atencionId: atencionRef.id, pago: pagoDoc.data() })
        }
        if (paginaPagos.size < PAGINA_CONSULTA) break
        cursor = paginaPagos.docs[paginaPagos.docs.length - 1]
      }

      const grupos = new Map<string, PagoCandidato[]>()
      for (const pago of pagos) grupos.set(pago.atencionId, [...(grupos.get(pago.atencionId) ?? []), pago])
      const atenciones = new Map<string, Registro | null>()
      await Promise.all([...grupos.keys()].map(async (atencionId) => {
        const snap = await getDoc(doc(db, 'atenciones', atencionId))
        atenciones.set(atencionId, snap.exists() ? snap.data() : null)
      }))

      const ventas: VentaValidada[] = []
      let pedidosLeidos = 0
      for (const [atencionId, candidatas] of grupos) {
        const atencion = atenciones.get(atencionId)
        if (!atencion) {
          for (const pago of candidatas) incidenciasLocales.push({ atencionId, pagoId: pago.id, motivo: 'No existe la atención asociada al pago; se excluyó.' })
          continue
        }
        const pagoCanonico = candidatas.find((pago) => pago.id === atencion.pagoId)
        if (!pagoCanonico) {
          for (const pago of candidatas) incidenciasLocales.push({ atencionId, pagoId: pago.id, motivo: 'Pago duplicado o no canónico; la atención referencia otro pago.' })
          continue
        }
        for (const extra of candidatas.filter((pago) => pago.id !== pagoCanonico.id)) {
          incidenciasLocales.push({ atencionId, pagoId: extra.id, motivo: 'Pago adicional de la misma atención; se excluyó para evitar duplicados.' })
        }
        if (atencion.estado !== 'cerrada') {
          incidenciasLocales.push({ atencionId, pagoId: pagoCanonico.id, motivo: 'La atención no está cerrada; se excluyó.' })
          continue
        }
        const cabecera = validarPagoAtencion({ atencionId, pagoId: pagoCanonico.id, pago: pagoCanonico.pago, atencion })
        if (cabecera.incidencias.length) {
          incidenciasLocales.push(...cabecera.incidencias)
          continue
        }
        const espacio = LIMITE_PEDIDOS - pedidosLeidos
        let pedidosSnap
        try {
          pedidosSnap = await getDocs(query(collection(db, 'atenciones', atencionId, 'pedidos'), limit(espacio + 1)))
        } catch {
          incidenciasLocales.push({ atencionId, pagoId: pagoCanonico.id, motivo: 'No se pudieron leer los pedidos para validar la venta; se excluyó.' })
          continue
        }
        if (pedidosSnap.size > espacio) {
          throw new Error(`El reporte supera el límite de ${LIMITE_PEDIDOS} pedidos. Acota las fechas para completar la validación.`)
        }
        pedidosLeidos += pedidosSnap.size
        const validacion = validarVenta({ atencionId, pagoId: pagoCanonico.id, pago: pagoCanonico.pago,
          atencion, pedidos: pedidosSnap.docs.map((pedido) => pedido.data()) })
        incidenciasLocales.push(...validacion.incidencias)
        if (validacion.venta) ventas.push(validacion.venta)
      }

      const resumen = resumirVentas(ventas)
      setReporte({ ...resumen, ventas: ventas.sort((a, b) => a.fecha.getTime() - b.fecha.getTime()), desde, hasta })
      setIncidencias([...incidenciasLocales, ...resumen.incidencias])
    } catch (err) {
      console.error('Error al generar reporte de ventas:', err)
      setError(err instanceof Error ? err.message : 'No se pudo generar el reporte.')
      limpiar()
    } finally { setCargando(false) }
  }

  const dinero = (centimos: number) => `S/ ${(centimos / 100).toFixed(2)}`
  const ventasPagina = reporte?.ventas.slice(pagina * TAMANO_PAGINA_TABLA, (pagina + 1) * TAMANO_PAGINA_TABLA) ?? []
  const paginas = reporte ? Math.max(1, Math.ceil(reporte.ventas.length / TAMANO_PAGINA_TABLA)) : 1

  return <section className="reportes-seccion">
    <div className="reportes-cabecera no-print">
      <div><h2>Reportes de ventas</h2><p>Consulta pagos confirmados y ventas verificadas.</p></div>
      <button type="button" className="reporte-imprimir" onClick={() => imprimirConFormato('a4')} disabled={!reporte}>Imprimir / Guardar como PDF</button>
    </div>
    <form className="reporte-filtros no-print" onSubmit={generarReporte}>
      <label>Desde (Perú)<input type="date" value={desde} onChange={(e) => { setDesde(e.target.value); limpiar() }} required /></label>
      <label>Hasta (Perú)<input type="date" value={hasta} onChange={(e) => { setHasta(e.target.value); limpiar() }} required /></label>
      <button type="submit" disabled={cargando}>{cargando ? 'Consultando…' : 'Generar reporte'}</button>
      <small>Máximo {LIMITE_DIAS} días, {LIMITE_PAGOS} pagos y {LIMITE_PEDIDOS} pedidos por reporte.</small>
    </form>
    {error && <p className="reporte-error no-print" role="alert">{error}</p>}
    {cargando && <p className="reporte-cargando no-print" role="status">Consultando pagos y verificando pedidos…</p>}
    {reporte && <div className="reporte-print-area">
      <header className="reporte-impresion-cabecera"><h1>SistemaPolleria</h1><p>Reporte de ventas: {reporte.desde} a {reporte.hasta} · Zona horaria: America/Lima</p></header>
      <div className="reporte-totales">
        <article><span>Total recaudado</span><strong>{dinero(reporte.totalCentimos)}</strong></article>
        <article><span>Efectivo</span><strong>{dinero(reporte.efectivoCentimos)}</strong></article>
        <article><span>Yape</span><strong>{dinero(reporte.yapeCentimos)}</strong></article>
        <article><span>Ventas verificadas</span><strong>{reporte.cantidadVentas}</strong></article>
      </div>
      <section className="reporte-ventas-diarias">
        <h3>Ventas por día</h3>
        {reporte.ventasPorDia.length === 0 ? <p>No hay ventas verificadas para este rango.</p> : <div className="reporte-tabla-wrap"><table>
          <thead><tr><th>Fecha (Perú)</th><th>Ventas</th><th>Total</th><th>Efectivo</th><th>Yape</th></tr></thead>
          <tbody>{reporte.ventasPorDia.map((dia) => <tr key={dia.fecha}>
            <td>{dia.fecha}</td><td>{dia.cantidadVentas}</td><td>{dinero(dia.totalCentimos)}</td>
            <td>{dinero(dia.efectivoCentimos)}</td><td>{dinero(dia.yapeCentimos)}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      {incidencias.length > 0 && <section className="reporte-incidencias">
        <h3>Incidencias excluidas ({incidencias.length})</h3>
        <ul>{incidencias.map((incidencia, i) => <li key={`${incidencia.atencionId}-${incidencia.pagoId ?? ''}-${i}`}>
          Atención {incidencia.atencionId}{incidencia.pagoId ? ` · pago ${incidencia.pagoId}` : ''}: {incidencia.motivo}
        </li>)}</ul>
      </section>}
      <section className="reporte-productos">
        <h3>Productos más vendidos</h3>
        {reporte.productos.length === 0 ? <p>No hay productos en ventas verificadas para este rango.</p> : <div className="reporte-tabla-wrap"><table>
          <thead><tr><th>Producto</th><th>Unidades</th><th>Subtotal vendido</th></tr></thead>
          <tbody>{reporte.productos.slice(0, 10).map((producto) => <tr key={producto.productoId}>
            <td>{producto.nombre}</td><td>{producto.cantidad}</td><td>{dinero(producto.subtotalCentimos)}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section className="reporte-ventas-lista">
        <h3>Ventas verificadas</h3>
        {reporte.ventas.length === 0 ? <p>No hay ventas verificadas para este rango.</p> : <div className="reporte-tabla-wrap"><table>
          <thead><tr><th>Fecha y hora</th><th>Atención</th><th>Mesa</th><th>Método</th><th>Total</th></tr></thead>
          <tbody className="reporte-ventas-pagina">{ventasPagina.map((venta) => <tr key={venta.atencionId}>
            <td>{venta.fecha.toLocaleString('es-PE', { timeZone: 'America/Lima' })}</td><td>{venta.atencionId}</td>
            <td>{venta.mesaNumero ?? '—'}</td><td>{venta.metodo === 'yape' ? 'Yape' : 'Efectivo'}</td><td>{dinero(venta.totalCentimos)}</td>
          </tr>)}</tbody>
          <tbody className="reporte-ventas-completas">{reporte.ventas.map((venta) => <tr key={venta.atencionId}>
            <td>{venta.fecha.toLocaleString('es-PE', { timeZone: 'America/Lima' })}</td><td>{venta.atencionId}</td>
            <td>{venta.mesaNumero ?? '—'}</td><td>{venta.metodo === 'yape' ? 'Yape' : 'Efectivo'}</td><td>{dinero(venta.totalCentimos)}</td>
          </tr>)}</tbody>
        </table></div>}
        {reporte.ventas.length > TAMANO_PAGINA_TABLA && <nav className="reporte-paginacion no-print" aria-label="Páginas de ventas">
          <button type="button" onClick={() => setPagina((p) => Math.max(0, p - 1))} disabled={pagina === 0}>Anterior</button>
          <span>Página {pagina + 1} de {paginas}</span>
          <button type="button" onClick={() => setPagina((p) => Math.min(paginas - 1, p + 1))} disabled={pagina >= paginas - 1}>Siguiente</button>
        </nav>}
      </section>
    </div>}
  </section>
}

export default ReportesVentas
