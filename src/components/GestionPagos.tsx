import { useEffect, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import TicketVenta from './TicketVenta'

type Mesa = {
  id: string
  numero: number
  estado: string
  atencionActivaId?: string | null
  comensales?: number
}

type Atencion = {
  mesaId: string
  mesaNumero: number
  estado: string
  total: number
  totalCentimos?: number
}

function totalCentimos(atencion: Atencion) {
  return Number.isSafeInteger(atencion.totalCentimos)
    ? atencion.totalCentimos!
    : Math.round((Number(atencion.total ?? 0) + Number.EPSILON) * 100)
}

function soles(centimos: number) {
  return `S/ ${(centimos / 100).toFixed(2)}`
}

function GestionPagos({ usuarioId }: { usuarioId: string }) {
  const [mesas, setMesas] = useState<Mesa[]>([])
  const [mesaId, setMesaId] = useState('')
  const [atencion, setAtencion] = useState<Atencion | null>(null)
  const [atencionIdValidada, setAtencionIdValidada] = useState('')
  const [metodo, setMetodo] = useState<'efectivo' | 'yape'>('efectivo')
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [ticketAtencionId, setTicketAtencionId] = useState('')
  const [ticketDisponibleId, setTicketDisponibleId] = useState('')
  const [idReimpresion, setIdReimpresion] = useState('')
  const [buscandoTicket, setBuscandoTicket] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'mesas'), where('estado', '==', 'ocupada'))
    return onSnapshot(q, (snapshot) => {
      const ocupadas = snapshot.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<Mesa, 'id'>) }))
        .filter((m) => typeof m.atencionActivaId === 'string' && m.atencionActivaId.length > 0)
        .sort((a, b) => a.numero - b.numero)
      setMesas(ocupadas)
      if (!ocupadas.some((m) => m.id === mesaId)) setMesaId(ocupadas[0]?.id ?? '')
      setCargando(false)
      setError('')
    }, (err) => {
      console.error('Error al cargar mesas para cobro:', err)
      setError('No se pudieron cargar las mesas ocupadas. Revisa los permisos de Firestore.')
      setCargando(false)
    })
  }, [mesaId])

  const mesa = mesas.find((m) => m.id === mesaId)
  const atencionId = mesa?.atencionActivaId ?? ''
  const atencionVisible = atencionIdValidada === atencionId ? atencion : null
  const cargandoAtencion = Boolean(atencionId) && atencionIdValidada !== atencionId
  const saldoAtencion = atencionVisible ? totalCentimos(atencionVisible) : null
  const atencionValidada = !cargandoAtencion
    && atencionIdValidada === atencionId
    && saldoAtencion !== null
    && Number.isSafeInteger(saldoAtencion)
    && saldoAtencion >= 0

  useEffect(() => {
    if (!atencionId) {
      return
    }
    return onSnapshot(doc(db, 'atenciones', atencionId), (snapshot) => {
      setAtencionIdValidada(atencionId)
      if (!snapshot.exists()) {
        setAtencion(null)
        setError('No se encontró la atención activa de esta mesa.')
        return
      }
      const data = snapshot.data() as Atencion
      if (data.mesaId !== mesaId || data.estado !== 'abierta') {
        setAtencion(null)
        setError('La atención ya no está abierta o no corresponde a esta mesa.')
        return
      }
      const saldo = totalCentimos(data)
      if (!Number.isSafeInteger(saldo) || saldo < 0) {
        setAtencion(null)
        setError('El total de la atención no es válido; no se puede confirmar el cobro.')
        return
      }
      setAtencion(data)
      setError('')
    }, (err) => {
      console.error('Error al cargar atención para cobro:', err)
      setAtencion(null)
      setAtencionIdValidada(atencionId)
      const mensaje = err.code === 'permission-denied'
        ? 'No tienes permisos para consultar esta atención. Revisa las reglas de lectura de Firestore.'
        : 'No se pudo cargar la atención activa. Inténtalo de nuevo.'
      setError(mensaje)
    })
  }, [atencionId, mesaId])

  async function confirmarPago() {
    if (auth.currentUser?.uid !== usuarioId) {
      setError('La sesión actual no corresponde al administrador autenticado.')
      return
    }
    if (!mesa || !atencionVisible || !atencionValidada || !atencionId) {
      setError('Selecciona una mesa con una atención abierta.')
      return
    }

    setGuardando(true)
    setError('')
    setMensaje('')
    const mesaRef = doc(db, 'mesas', mesa.id)
    const atencionRef = doc(db, 'atenciones', atencionId)
    const pagoRef = doc(collection(db, 'atenciones', atencionId, 'pagos'))
    try {
      const importe = await runTransaction(db, async (tx) => {
        const [mesaSnap, atencionSnap, pagoSnap] = await Promise.all([
          tx.get(mesaRef), tx.get(atencionRef), tx.get(pagoRef),
        ])
        if (pagoSnap.exists()) throw new Error('El pago ya fue registrado. Actualiza la selección.')
        if (!mesaSnap.exists() || !atencionSnap.exists()) throw new Error('La mesa o atención ya no están disponibles.')
        const mesaActual = mesaSnap.data() as Mesa
        const atencionActual = atencionSnap.data() as Atencion
        if (
          mesaActual.estado !== 'ocupada' || mesaActual.atencionActivaId !== atencionId ||
          atencionActual.estado !== 'abierta' || atencionActual.mesaId !== mesa.id
        ) throw new Error('La mesa ya no tiene esa atención abierta.')
        const saldo = totalCentimos(atencionActual)
        if (!Number.isSafeInteger(saldo) || saldo < 0) throw new Error('El total de la atención no es válido.')

        tx.set(pagoRef, {
          metodo,
          importeCentimos: saldo,
          importe: saldo / 100,
          registradoEn: serverTimestamp(),
          confirmadoPor: usuarioId,
        })
        tx.update(atencionRef, {
          estado: 'cerrada',
          cierre: serverTimestamp(),
          metodoPago: metodo,
          pagoId: pagoRef.id,
          totalPagadoCentimos: saldo,
        })
        tx.update(mesaRef, {
          estado: 'libre',
          atencionActivaId: null,
          mozoId: null,
          mozoNombre: null,
          comensales: null,
          inicioAtencion: null,
        })
        return saldo
      })
      setMensaje(`Pago de ${soles(importe)} confirmado en ${metodo === 'yape' ? 'Yape' : 'efectivo'}. Atención cerrada; mesa liberada.`)
      setTicketDisponibleId(atencionId)
      setAtencion(null)
    } catch (err) {
      console.error('Error al confirmar pago:', err)
      setError(err instanceof Error ? err.message : 'No se pudo confirmar el pago.')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <section className="mesas-seccion">
      <div className="mesas-titulo"><div><h2>Caja y pagos</h2><p>Confirma manualmente el pago completo para cerrar la atención.</p></div></div>
      {mensaje && <p className="mesas-mensaje" role="status">{mensaje}</p>}
      {ticketDisponibleId && <button type="button" className="mesa-accion" onClick={() => setTicketAtencionId(ticketDisponibleId)}>Ver/Imprimir ticket</button>}
      {error && <p className="mesas-error" role="alert">{error}</p>}
      {cargando && <p>Cargando mesas ocupadas…</p>}
      {!cargando && mesas.length === 0 && <p>No hay atenciones pendientes de cobro.</p>}
      {mesas.length > 0 && <>
        <label>Mesa por cobrar{' '}
          <select value={mesaId} onChange={(e) => { setMesaId(e.target.value); setAtencion(null); setMensaje(''); setError('') }} disabled={guardando}>
            {mesas.map((m) => <option key={m.id} value={m.id}>Mesa {String(m.numero).padStart(2, '0')}</option>)}
          </select>
        </label>
        {mesa && <p>Total pendiente: <strong>{cargandoAtencion ? 'Cargando…' : atencionValidada && saldoAtencion !== null ? soles(saldoAtencion) : 'No disponible'}</strong></p>}
        <label>Método de pago{' '}
          <select value={metodo} onChange={(e) => setMetodo(e.target.value as 'efectivo' | 'yape')} disabled={guardando}>
            <option value="efectivo">Efectivo</option><option value="yape">Yape</option>
          </select>
        </label>
        <p>Al confirmar, se registrará el importe pendiente y la mesa quedará libre.</p>
        <button type="button" className="mesa-accion" onClick={confirmarPago} disabled={guardando || !atencionValidada}>
          {guardando ? 'Confirmando…' : 'Confirmar pago y cerrar atención'}
        </button>
      </>}
      <div className="reimpresion-ticket">
        <h3>Reimprimir ticket</h3>
        <p>Ingresa el ID exacto de una atención cerrada y pagada.</p>
        <form onSubmit={async (e) => {
          e.preventDefault(); setBuscandoTicket(true); setError('')
          try {
            const id = idReimpresion.trim()
            if (!id) throw new Error('Ingresa un ID de atención.')
            const snap = await getDoc(doc(db, 'atenciones', id))
            if (!snap.exists()) throw new Error('No se encontró esa atención.')
            const data = snap.data()
            if (data.estado !== 'cerrada' || !data.pagoId || !['efectivo', 'yape'].includes(data.metodoPago))
              throw new Error('La atención no está cerrada y pagada.')
            const pago = await getDoc(doc(db, 'atenciones', id, 'pagos', data.pagoId))
            if (!pago.exists()) throw new Error('No se encontró el pago de esa atención.')
            await getDocs(collection(db, 'atenciones', id, 'pedidos'))
            setTicketDisponibleId(id)
            setTicketAtencionId(id)
          } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo validar la atención.') }
          finally { setBuscandoTicket(false) }
        }}>
          <label htmlFor="ticket-atencion-id">ID de atención</label>
          <input id="ticket-atencion-id" value={idReimpresion} onChange={(e) => setIdReimpresion(e.target.value)} maxLength={128} required />
          <button type="submit" className="mesa-accion" disabled={buscandoTicket}>{buscandoTicket ? 'Validando…' : 'Ver ticket'}</button>
        </form>
      </div>
      {ticketAtencionId && <TicketVenta atencionId={ticketAtencionId} onCerrar={() => setTicketAtencionId('')} />}
    </section>
  )
}

export default GestionPagos
