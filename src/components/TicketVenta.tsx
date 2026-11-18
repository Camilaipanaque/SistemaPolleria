import { useEffect, useState } from 'react'
import { collection, doc, getDoc, getDocs, Timestamp } from 'firebase/firestore'
import { db } from '../firebase'
import { imprimirConFormato, validarVenta } from './reportesVentasUtils'
import './TicketVenta.css'

type Props = { atencionId: string; onCerrar: () => void }
type Linea = { nombre: string; cantidad: number; precioUnitarioCentimos: number; subtotalCentimos: number }
type DatosTicket = { atencionId: string; mesaNumero: number; pagoFecha: Date; metodo: string; totalCentimos: number; lineas: Linea[] }

function TicketVenta({ atencionId, onCerrar }: Props) {
  const [ticket, setTicket] = useState<DatosTicket | null>(null)
  const [error, setError] = useState('')
  const [negocio, setNegocio] = useState(() => localStorage.getItem('nombreNegocioTicket') || import.meta.env.VITE_NOMBRE_NEGOCIO || 'SistemaPolleria')
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    let activo = true
    async function cargar() {
      setCargando(true); setError(''); setTicket(null)
      try {
        if (!atencionId.trim()) throw new Error('Ingresa un identificador de atención válido.')
        const ref = doc(db, 'atenciones', atencionId.trim())
        const atencionSnap = await getDoc(ref)
        if (!atencionSnap.exists()) throw new Error('No existe una atención con ese identificador.')
        const atencion = atencionSnap.data()
        if (atencion.estado !== 'cerrada' || !atencion.pagoId || !['efectivo', 'yape'].includes(atencion.metodoPago))
          throw new Error('El ticket solo está disponible para atenciones cerradas y pagadas.')
        const pagoSnap = await getDoc(doc(db, 'atenciones', atencionId.trim(), 'pagos', atencion.pagoId))
        if (!pagoSnap.exists()) throw new Error('No se encontró el pago de esta atención.')
        const pago = pagoSnap.data()
        const orders = await getDocs(collection(db, 'atenciones', atencionId.trim(), 'pedidos'))
        const validation = validarVenta({ atencionId: atencionId.trim(), pagoId: atencion.pagoId, pago,
          atencion, pedidos: orders.docs.map((pedido) => ({ id: pedido.id, ...pedido.data() })) })
        if (!validation.venta) throw new Error(`No se puede emitir el ticket: ${validation.incidencias.map((item) => item.motivo).join(' ')}`)
        const venta = validation.venta
        const lineas = venta.lineas
        const fecha = pago.registradoEn instanceof Timestamp ? pago.registradoEn.toDate() :
          pago.registradoEn?.toDate?.() ?? (pago.registradoEn instanceof Date ? pago.registradoEn : null)
        if (!fecha || Number.isNaN(fecha.getTime())) throw new Error('La fecha real del pago todavía no está disponible.')
        if (activo) setTicket({ atencionId: atencionId.trim(), mesaNumero: Number(atencion.mesaNumero), pagoFecha: fecha,
          metodo: venta.metodo, totalCentimos: venta.totalCentimos, lineas })
      } catch (e) { if (activo) setError(e instanceof Error ? e.message : 'No se pudo validar el ticket.') }
      finally { if (activo) setCargando(false) }
    }
    void cargar()
    return () => { activo = false }
  }, [atencionId])

  function guardarNegocio(value: string) { setNegocio(value); localStorage.setItem('nombreNegocioTicket', value) }
  const dinero = (n: number) => `S/ ${(n / 100).toFixed(2)}`
  return <div className="ticket-overlay" role="dialog" aria-modal="true" aria-label="Ticket de venta">
    <div className="ticket-panel">
      <div className="ticket-controles no-print">
        <label>Nombre del negocio <input value={negocio} maxLength={80} onChange={(e) => guardarNegocio(e.target.value)} /></label>
        <button type="button" onClick={() => imprimirConFormato('ticket')} disabled={!ticket}>Imprimir / Guardar PDF</button>
        <button type="button" className="ticket-cerrar" onClick={onCerrar}>Cerrar</button>
      </div>
      {cargando && <p className="ticket-aviso">Validando atención, pedidos y pago…</p>}
      {error && <p className="ticket-error" role="alert">{error}</p>}
      {ticket && <article className="ticket-papel">
        <header><h1>{negocio || 'SistemaPolleria'}</h1><p>COMPROBANTE INTERNO DE VENTA</p></header>
        <div className="ticket-meta"><span>Atención: {ticket.atencionId}</span><span>Mesa: {ticket.mesaNumero}</span>
          <span>Pago: {ticket.pagoFecha.toLocaleString('es-PE')}</span></div>
        <table><thead><tr><th>Producto</th><th>Cant.</th><th>P. unit.</th><th>Subtotal</th></tr></thead>
          <tbody>{ticket.lineas.map((l, i) => <tr key={`${l.nombre}-${i}`}><td>{l.nombre}</td><td>{l.cantidad}</td><td>{dinero(l.precioUnitarioCentimos)}</td><td>{dinero(l.subtotalCentimos)}</td></tr>)}</tbody>
        </table>
        <div className="ticket-total"><span>TOTAL</span><strong>{dinero(ticket.totalCentimos)}</strong></div>
        <p className="ticket-metodo">Método de pago: <strong>{ticket.metodo === 'yape' ? 'Yape' : 'Efectivo'}</strong></p>
        <footer>Gracias por su preferencia</footer>
      </article>}
    </div>
  </div>
}
export default TicketVenta
