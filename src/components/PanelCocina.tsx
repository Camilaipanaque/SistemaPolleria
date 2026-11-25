import { useEffect, useMemo, useState } from 'react'
import {
  collectionGroup,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  where,
  type Timestamp,
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import './PanelCocina.css'

type EstadoCocina = 'recibido' | 'preparando' | 'listo'
type ItemCocina = {
  productoId: string
  nombre: string
  presentacion?: string
  cantidad: number
  observacion?: string
}
type PedidoCocina = {
  atencionId: string
  pedidoId: string
  mesaId: string
  mesaNumero: number
  creadoPor: string
  creadoEn: Timestamp | Date
  estado: EstadoCocina
  items: ItemCocina[]
  observaciones?: string
}

type PanelCocinaProps = {
  usuarioId: string
  nombreUsuario: string
  modo?: 'cocina' | 'mozo'
  puedeEntregar?: boolean
  onCerrarSesion?: () => void
  onVolver?: () => void
}

const estados: EstadoCocina[] = ['recibido', 'preparando', 'listo']
const etiquetaEstado: Record<EstadoCocina, string> = {
  recibido: 'Pendiente',
  preparando: 'Preparando',
  listo: 'Listo',
}

function fechaPedido(fecha: PedidoCocina['creadoEn']) {
  const date = fecha instanceof Date ? fecha : fecha?.toDate?.()
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
    : 'Hora no disponible'
}

function timestampPedido(fecha: PedidoCocina['creadoEn']) {
  const date = fecha instanceof Date ? fecha : fecha?.toDate?.()
  return date?.getTime() ?? 0
}

function PanelCocina({ usuarioId, nombreUsuario, modo = 'cocina', puedeEntregar = false, onCerrarSesion, onVolver }: PanelCocinaProps) {
  const [pedidos, setPedidos] = useState<PedidoCocina[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [actualizando, setActualizando] = useState<string | null>(null)
  const [mensaje, setMensaje] = useState('')

  useEffect(() => {
    const porEstado = new Map<EstadoCocina, PedidoCocina[]>()
    const estadosCargados = new Set<EstadoCocina>()
    const estadosConsultados = modo === 'mozo' ? ['listo' as const] : estados
    const cancelar = estadosConsultados.map((estado) => onSnapshot(query(
      collectionGroup(db, 'cocina'),
      where('estado', '==', estado),
      orderBy('creadoEn', 'asc'),
      limit(200),
    ), (resultado) => {
      porEstado.set(estado, resultado.docs.map((documento) => documento.data() as PedidoCocina))
      estadosCargados.add(estado)
      setPedidos([...porEstado.values()].flat())
      setCargando(estadosCargados.size < estadosConsultados.length)
      setError('')
    }, (err) => {
      console.error('Error al cargar comandas:', err)
      setError('No se pudieron cargar los pedidos. Comprueba tu conexión o los permisos de Cocina.')
      setCargando(false)
    }))
    return () => cancelar.forEach((detener) => detener())
  }, [modo])

  const contadores = useMemo(() => ({
    recibido: pedidos.filter((pedido) => pedido.estado === 'recibido').length,
    preparando: pedidos.filter((pedido) => pedido.estado === 'preparando').length,
    listo: pedidos.filter((pedido) => pedido.estado === 'listo').length,
  }), [pedidos])

  const pedidosOrdenados = useMemo(() => [...pedidos].sort((a, b) => {
    const orden: Record<EstadoCocina, number> = { recibido: 0, preparando: 1, listo: 2 }
    return orden[a.estado] - orden[b.estado] || timestampPedido(a.creadoEn) - timestampPedido(b.creadoEn)
  }), [pedidos])

  const pedidosVisibles = modo === 'mozo'
    ? pedidosOrdenados.filter((pedido) => pedido.estado === 'listo')
    : pedidosOrdenados

  async function cambiarEstado(pedido: PedidoCocina) {
    if (auth.currentUser?.uid !== usuarioId || actualizando) return
    const siguiente: EstadoCocina | null = pedido.estado === 'recibido'
      ? 'preparando'
      : pedido.estado === 'preparando' ? 'listo' : null
    if (!siguiente) return

    const llave = `${pedido.atencionId}/${pedido.pedidoId}`
    setActualizando(llave)
    setMensaje('')
    setError('')
    try {
      const pedidoRef = doc(db, 'atenciones', pedido.atencionId, 'pedidos', pedido.pedidoId)
      const comandaRef = doc(pedidoRef, 'cocina', 'resumen')
      await runTransaction(db, async (transaccion) => {
        const comandaActual = await transaccion.get(comandaRef)
        if (!comandaActual.exists()) throw new Error('El resumen del pedido ya no existe.')
        const estadoActual = comandaActual.data().estado
        if (estadoActual !== pedido.estado) {
          throw new Error('El pedido cambió. Actualiza la pantalla.')
        }
        if (estadoActual !== 'recibido' && estadoActual !== 'preparando') {
          throw new Error('Esta transición ya no está disponible.')
        }
        transaccion.update(pedidoRef, { estado: siguiente })
        transaccion.update(comandaRef, { estado: siguiente })
      })
      setMensaje(`Pedido ${pedido.pedidoId} actualizado: ${etiquetaEstado[siguiente]}.`)
    } catch (err) {
      console.error('Error al cambiar estado de cocina:', err)
      setError('El pedido cambió en otra sesión o no se pudo actualizar. Actualiza la pantalla e inténtalo de nuevo.')
    } finally {
      setActualizando(null)
    }
  }

  async function marcarEntregado(pedido: PedidoCocina) {
    if (auth.currentUser?.uid !== usuarioId || actualizando || pedido.estado !== 'listo') return
    const llave = `${pedido.atencionId}/${pedido.pedidoId}`
    setActualizando(llave)
    setMensaje('')
    setError('')
    try {
      const pedidoRef = doc(db, 'atenciones', pedido.atencionId, 'pedidos', pedido.pedidoId)
      const comandaRef = doc(pedidoRef, 'cocina', 'resumen')
      await runTransaction(db, async (transaccion) => {
        const comandaActual = await transaccion.get(comandaRef)
        if (!comandaActual.exists() || comandaActual.data().estado !== 'listo') {
          throw new Error('El pedido ya cambió. Actualiza la pantalla.')
        }
        transaccion.update(pedidoRef, { estado: 'entregado' })
        transaccion.update(comandaRef, { estado: 'entregado' })
      })
      setMensaje(`Pedido ${pedido.pedidoId} marcado como entregado.`)
    } catch (err) {
      console.error('Error al marcar pedido como entregado:', err)
      setError(err instanceof Error ? err.message : 'No se pudo marcar el pedido como entregado.')
    } finally {
      setActualizando(null)
    }
  }

  return (
    <main className={`cocina-app ${modo === 'mozo' ? 'cocina-app-mozo' : ''}`}>
      <header className="cocina-header">
        <div className="cocina-marca"><span className="cocina-marca-icono">✦</span><div><p>SISTEMAPOLLERIA</p><h1>{modo === 'mozo' ? 'Pedidos listos' : 'Panel de Cocina'}</h1></div></div>
        <div className="cocina-usuario"><span>{nombreUsuario}</span>{onVolver && <button type="button" onClick={onVolver}>Volver al panel</button>}{onCerrarSesion && <button type="button" onClick={onCerrarSesion}>Cerrar sesión</button>}</div>
      </header>

      <section className="cocina-contenido">
        <div className="cocina-intro"><div><p className="cocina-eyebrow">SERVICIO EN TIEMPO REAL</p><h2>{modo === 'mozo' ? 'Listos para servir' : 'Comandas activas'}</h2><p>{modo === 'mozo' ? 'Aquí verás los pedidos que Cocina marcó como listos.' : 'Las comandas más antiguas aparecen primero dentro de cada estado.'}</p></div><span className="cocina-live"><i /> EN VIVO</span></div>

        <section className="cocina-contadores" aria-label="Pedidos por estado">
          {estados.map((estado) => <article className={`cocina-contador cocina-contador-${estado}`} key={estado}><span>{etiquetaEstado[estado]}</span><strong>{contadores[estado]}</strong></article>)}
        </section>

        {mensaje && <p className="cocina-mensaje" role="status">{mensaje}</p>}
        {error && <p className="cocina-error" role="alert">{error}</p>}
        {cargando && <p className="cocina-vacio">Conectando con la cocina…</p>}
        {!cargando && !error && pedidosVisibles.length === 0 && <p className="cocina-vacio">{modo === 'mozo' ? 'Todavía no hay pedidos listos.' : 'No hay comandas activas.'}</p>}

        <section className="cocina-pedidos" aria-live="polite">
          {pedidosVisibles.map((pedido) => {
            const llave = `${pedido.atencionId}/${pedido.pedidoId}`
            const siguiente = pedido.estado === 'recibido' ? 'preparando' : pedido.estado === 'preparando' ? 'listo' : null
            return <article className={`cocina-pedido cocina-pedido-${pedido.estado}`} key={llave}>
              <header className="cocina-pedido-header">
                <div><span className="cocina-mesa">MESA {String(pedido.mesaNumero).padStart(2, '0')}</span><h3>Pedido #{pedido.pedidoId}</h3></div>
                <div className="cocina-pedido-meta"><time>{fechaPedido(pedido.creadoEn)}</time><span className={`cocina-estado cocina-estado-${pedido.estado}`}>{etiquetaEstado[pedido.estado]}</span></div>
              </header>
              <ul className="cocina-items">{pedido.items.map((item, index) => <li key={`${item.productoId}-${index}`}><span className="cocina-cantidad">{item.cantidad}×</span><div><strong>{item.nombre}</strong>{item.presentacion && <span className="cocina-presentacion">{item.presentacion}</span>}{item.observacion && <span className="cocina-observacion">Nota: {item.observacion}</span>}</div></li>)}</ul>
              {pedido.observaciones && <p className="cocina-nota"><strong>Observaciones:</strong> {pedido.observaciones}</p>}
              {modo === 'cocina' && siguiente && <button type="button" className="cocina-avanzar" disabled={actualizando === llave} onClick={() => void cambiarEstado(pedido)}>{actualizando === llave ? 'Actualizando…' : siguiente === 'preparando' ? 'Iniciar preparación' : 'Marcar listo'}<span>→</span></button>}
              {modo === 'mozo' && <button type="button" className="cocina-avanzar" disabled={actualizando === llave} onClick={() => void marcarEntregado(pedido)}>{actualizando === llave ? 'Actualizando…' : 'Marcar como entregado'}<span>✓</span></button>}
              {modo === 'cocina' && puedeEntregar && pedido.estado === 'listo' && <button type="button" className="cocina-avanzar" disabled={actualizando === llave} onClick={() => void marcarEntregado(pedido)}>{actualizando === llave ? 'Actualizando…' : 'Marcar como entregado'}<span>✓</span></button>}
            </article>
          })}
        </section>
      </section>
    </main>
  )
}

export default PanelCocina
