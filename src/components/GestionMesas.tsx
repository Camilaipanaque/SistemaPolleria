import { useEffect, useState } from 'react'
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { auth, db } from '../firebase'

type Mesa = {
  id: string
  numero: number
  estado: 'libre' | 'ocupada' | 'pendiente_pago'
  atencionActivaId?: string | null
  capacidad?: number
  comensales?: number
  mozoNombre?: string
}

type GestionMesasProps = {
  usuarioId: string
  nombreUsuario: string
}

function GestionMesas({ usuarioId, nombreUsuario }: GestionMesasProps) {
  const [mesas, setMesas] = useState<Mesa[]>([])
  const [filtro, setFiltro] = useState('todas')
  const [cargando, setCargando] = useState(true)
  const [mesaEnProceso, setMesaEnProceso] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [mensaje, setMensaje] = useState('')

  useEffect(() => {
    const consulta = query(collection(db, 'mesas'), orderBy('numero', 'asc'))
    return onSnapshot(
      consulta,
      (resultado) => {
        setMesas(
          resultado.docs.map((documento) => ({
            id: documento.id,
            ...(documento.data() as Omit<Mesa, 'id'>),
          }))
        )
        setCargando(false)
        setError('')
      },
      (err) => {
        console.error('Error al cargar mesas:', err)
        setError('No se pudieron cargar las mesas. Revisa los permisos de Firestore.')
        setCargando(false)
      }
    )
  }, [])

  async function iniciarAtencion(mesa: Mesa) {
    if (auth.currentUser?.uid !== usuarioId) {
      setError('La sesión actual no corresponde al usuario autenticado.')
      return
    }

    const respuesta = window.prompt(`¿Cuántos comensales atenderás en la mesa ${mesa.numero}?`, '2')
    if (respuesta === null) return
    const comensales = Number(respuesta)
    if (!Number.isInteger(comensales) || comensales < 1) {
      setError('Ingresa una cantidad válida de comensales.')
      return
    }

    setMesaEnProceso(mesa.id)
    setError('')
    setMensaje('')
    const atencionRef = doc(collection(db, 'atenciones'))

    try {
      const numeroMesa = await runTransaction(db, async (transaccion) => {
        const mesaRef = doc(db, 'mesas', mesa.id)
        const mesaActual = await transaccion.get(mesaRef)
        if (!mesaActual.exists() || mesaActual.data().estado !== 'libre') {
          throw new Error('Esta mesa ya no está libre. Actualiza la lista e inténtalo de nuevo.')
        }

        const numeroMesaActual = mesaActual.data().numero
        if (typeof numeroMesaActual !== 'number' || !Number.isFinite(numeroMesaActual)) {
          throw new Error('El número de mesa registrado no es válido.')
        }

        transaccion.set(atencionRef, {
          mesaId: mesa.id,
          mesaNumero: numeroMesaActual,
          mozoId: usuarioId,
          mozoNombre: nombreUsuario,
          comensales,
          estado: 'abierta',
          inicio: serverTimestamp(),
          cierre: null,
          total: 0,
          totalCentimos: 0,
        })
        transaccion.update(mesaRef, {
          estado: 'ocupada',
          atencionActivaId: atencionRef.id,
          mozoId: usuarioId,
          mozoNombre: nombreUsuario,
          comensales,
          inicioAtencion: serverTimestamp(),
        })

        return numeroMesaActual
      })
      setMensaje(`Atención iniciada para la mesa ${numeroMesa}.`)
    } catch (err) {
      console.error('Error al iniciar atención:', err)
      setError(err instanceof Error ? err.message : 'No se pudo iniciar la atención.')
    } finally {
      setMesaEnProceso(null)
    }
  }

  const mesasVisibles = filtro === 'todas' ? mesas : mesas.filter((mesa) => mesa.estado === filtro)

  return (
    <section className="mesas-seccion">
      <div className="mesas-titulo">
        <div>
          <h2>Gestión de mesas</h2>
          <p>Consulta disponibilidad e inicia una atención.</p>
        </div>
        <label>
          Filtrar:{' '}
          <select value={filtro} onChange={(evento) => setFiltro(evento.target.value)}>
            <option value="todas">Todas</option>
            <option value="libre">Libres</option>
            <option value="ocupada">Ocupadas</option>
            <option value="pendiente_pago">Pendientes de pago</option>
          </select>
        </label>
      </div>

      {mensaje && <p className="mesas-mensaje" role="status">{mensaje}</p>}
      {error && <p className="mesas-error" role="alert">{error}</p>}
      {cargando && <p>Cargando mesas…</p>}
      {!cargando && mesas.length === 0 && <p>No hay mesas registradas en Firestore todavía.</p>}

      <div className="mesas-grid">
        {mesasVisibles.map((mesa) => (
          <article className={`mesa-tarjeta estado-${mesa.estado}`} key={mesa.id}>
            <div className="mesa-tarjeta-cabecera">
              <span className="mesa-icono" aria-hidden="true">♧</span>
              <span className={`mesa-estado estado-texto-${mesa.estado}`}>
                {mesa.estado === 'libre' ? 'Libre' : mesa.estado === 'ocupada' ? 'Ocupada' : 'Pendiente de pago'}
              </span>
            </div>
            <h3>Mesa {String(mesa.numero).padStart(2, '0')}</h3>
            {mesa.estado === 'ocupada' && (
              <p>{mesa.comensales ?? '—'} comensales · {mesa.mozoNombre ?? 'Atención activa'}</p>
            )}
            {mesa.estado === 'pendiente_pago' && <p>Esperando registro de pago</p>}
            {mesa.estado === 'libre' && <p>{mesa.capacidad ? `Capacidad: ${mesa.capacidad}` : 'Lista para recibir clientes'}</p>}
            {mesa.estado === 'libre' && (
              <button
                className="mesa-accion"
                type="button"
                disabled={mesaEnProceso === mesa.id}
                onClick={() => iniciarAtencion(mesa)}
              >
                {mesaEnProceso === mesa.id ? 'Iniciando…' : 'Iniciar atención'}
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

export default GestionMesas
