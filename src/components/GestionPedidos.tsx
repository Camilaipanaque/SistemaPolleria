import { useEffect, useMemo, useRef, useState } from 'react'
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { auth, db } from '../firebase'

type Mesa = {
  id: string
  numero: number
  estado: string
  atencionActivaId?: string | null
  comensales?: number
}

type Producto = {
  id: string
  nombre: string
  categoria: string
  precio?: number
  precioCentimos?: number
  activo: boolean
}

type Atencion = {
  mesaId: string
  mesaNumero: number
  comensales: number
  estado: string
  total: number
  totalCentimos?: number
}

type GestionPedidosProps = {
  usuarioId: string
}

type ResultadoPedido = {
  repetido: boolean
  totalPedido: number
  totalAtencion: number
}

function soles(valor: number) {
  return `S/ ${valor.toFixed(2)}`
}

function centimosProducto(producto: Pick<Producto, 'precio' | 'precioCentimos'>) {
  if (Number.isSafeInteger(producto.precioCentimos)) return producto.precioCentimos!
  return Math.round((Number(producto.precio ?? 0) + Number.EPSILON) * 100)
}

function GestionPedidos({ usuarioId }: GestionPedidosProps) {
  const [mesas, setMesas] = useState<Mesa[]>([])
  const [productos, setProductos] = useState<Producto[]>([])
  const [atencion, setAtencion] = useState<Atencion | null>(null)
  const [atencionCargadaId, setAtencionCargadaId] = useState('')
  const [mesaSeleccionadaId, setMesaSeleccionadaId] = useState('')
  const [cantidades, setCantidades] = useState<Record<string, number>>({})
  const [cargandoMesas, setCargandoMesas] = useState(true)
  const [cargandoProductos, setCargandoProductos] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [mensaje, setMensaje] = useState('')
  const pedidoPendiente = useRef<{ clave: string; referencia: ReturnType<typeof doc> } | null>(null)

  useEffect(() => {
    const consulta = query(collection(db, 'mesas'), where('estado', '==', 'ocupada'))
    return onSnapshot(
      consulta,
      (resultado) => {
        const mesasOcupadas = resultado.docs
          .map((documento) => ({ id: documento.id, ...(documento.data() as Omit<Mesa, 'id'>) }))
          .sort((a, b) => a.numero - b.numero)
        setMesas(mesasOcupadas)
        setCargandoMesas(false)
        setError('')
      },
      (err) => {
        console.error('Error al cargar mesas ocupadas:', err)
        setError('No se pudieron cargar las mesas ocupadas. Revisa los permisos de Firestore.')
        setCargandoMesas(false)
      }
    )
  }, [])

  useEffect(() => {
    const consulta = query(collection(db, 'productos'), where('activo', '==', true))
    return onSnapshot(
      consulta,
      (resultado) => {
        const productosActivos = resultado.docs
          .map((documento) => {
            const datos = documento.data() as Omit<Producto, 'id'>
            return {
              id: documento.id,
              ...datos,
              // Legacy catalog records remain usable without an automatic write.
              precioCentimos: Number.isSafeInteger(datos.precioCentimos)
                ? datos.precioCentimos
                : Math.round((Number(datos.precio ?? 0) + Number.EPSILON) * 100),
            }
          })
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
        setProductos(productosActivos)
        setCargandoProductos(false)
        setError('')
      },
      (err) => {
        console.error('Error al cargar productos activos:', err)
        setError('No se pudieron cargar los productos activos. Revisa los permisos de Firestore.')
        setCargandoProductos(false)
      }
    )
  }, [])

  const mesaSeleccionada = mesas.find((mesa) => mesa.id === mesaSeleccionadaId)
  const atencionActivaId = mesaSeleccionada?.atencionActivaId || ''
  const atencionVisible = atencionCargadaId === atencionActivaId ? atencion : null

  useEffect(() => {
    if (!atencionActivaId) return

    return onSnapshot(
      doc(db, 'atenciones', atencionActivaId),
      (documento) => {
        setAtencionCargadaId(atencionActivaId)
        if (!documento.exists()) {
          setAtencion(null)
          setError('La mesa no tiene un documento de atención activo válido.')
          return
        }

        const datos = documento.data() as Atencion
        if (datos.mesaId !== mesaSeleccionadaId || datos.estado !== 'abierta') {
          setAtencion(null)
          setError('La atención activa no coincide con la mesa o ya no está abierta.')
          return
        }

        setAtencion(datos)
        setError('')
      },
      (err) => {
        console.error('Error al cargar atención activa:', err)
        setAtencionCargadaId(atencionActivaId)
        setAtencion(null)
        setError('No se pudo recuperar la atención activa de la mesa.')
      }
    )
  }, [mesaSeleccionadaId, atencionActivaId])

  const lineas = useMemo(
    () => productos
      .filter((producto) => (cantidades[producto.id] ?? 0) > 0)
      .map((producto) => {
        const cantidad = cantidades[producto.id]
        const subtotalCentimos = centimosProducto(producto) * cantidad
        return { producto, cantidad, subtotalCentimos, subtotal: subtotalCentimos / 100 }
      }),
    [productos, cantidades]
  )

  const totalCentimosMostrado = lineas.reduce((suma, linea) => suma + linea.subtotalCentimos, 0)
  const totalMostrado = totalCentimosMostrado / 100
  const productosNoDisponibles = Object.keys(cantidades).filter(
    (productoId) => !productos.some((producto) => producto.id === productoId)
  )

  function cambiarCantidad(productoId: string, cantidad: number) {
    setCantidades((actuales) => {
      if (cantidad <= 0) {
        const siguientes = { ...actuales }
        delete siguientes[productoId]
        return siguientes
      }
      return { ...actuales, [productoId]: cantidad }
    })
    setError('')
    setMensaje('')
  }

  function cambiarMesa(mesaId: string) {
    setMesaSeleccionadaId(mesaId)
    setCantidades({})
    pedidoPendiente.current = null
    setAtencion(null)
    setError('')
    setMensaje('')
  }

  async function guardarPedido() {
    setError('')
    setMensaje('')

    if (auth.currentUser?.uid !== usuarioId) {
      setError('La sesión actual no corresponde al usuario autenticado.')
      return
    }
    if (!mesaSeleccionada || !atencionActivaId || !atencionVisible) {
      setError('Selecciona una mesa con una atención activa abierta.')
      return
    }
    if (lineas.length === 0) {
      setError('Agrega al menos un producto al pedido.')
      return
    }
    if (lineas.length > 4) {
      setError('Un pedido puede contener como máximo cuatro productos distintos por los límites de validación de Firestore.')
      return
    }
    if (lineas.some((linea) => !Number.isSafeInteger(linea.cantidad) || linea.cantidad < 1 || linea.cantidad > 1000000)) {
      setError('Las cantidades deben ser enteros positivos de hasta 1,000,000.')
      return
    }
    if (productosNoDisponibles.length > 0) {
      setError('Uno o más productos del pedido dejaron de estar activos. Quítalos antes de continuar.')
      return
    }

    const clave = JSON.stringify({
      mesaId: mesaSeleccionada.id,
      atencionId: atencionActivaId,
      lineas: lineas.map(({ producto, cantidad }) => [producto.id, cantidad]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    })
    if (!pedidoPendiente.current || pedidoPendiente.current.clave !== clave) {
      pedidoPendiente.current = {
        clave,
        referencia: doc(collection(db, 'atenciones', atencionActivaId, 'pedidos')),
      }
    }

    const pedidoRef = pedidoPendiente.current.referencia
    const mesaId = mesaSeleccionada.id
    const uid = usuarioId
    const cantidadesPedido = Object.fromEntries(lineas.map(({ producto, cantidad }) => [producto.id, cantidad]))

    setGuardando(true)
    try {
      const resultado = await runTransaction<ResultadoPedido>(db, async (transaccion) => {
        const mesaRef = doc(db, 'mesas', mesaId)
        const atencionRef = doc(db, 'atenciones', atencionActivaId)
        const [mesaDoc, atencionDoc, pedidoDoc] = await Promise.all([
          transaccion.get(mesaRef),
          transaccion.get(atencionRef),
          transaccion.get(pedidoRef),
        ])

        if (pedidoDoc.exists()) {
          const pedidoExistente = pedidoDoc.data()
          if (pedidoExistente.atencionId !== atencionActivaId || pedidoExistente.mesaId !== mesaId) {
            throw new Error('El identificador pendiente ya está asociado a otro pedido.')
          }
          return {
            repetido: true,
            totalPedido: Number(pedidoExistente.total),
              totalAtencion: Number(atencionDoc.data()?.total ?? atencionVisible?.total ?? 0),
          }
        }

        if (!mesaDoc.exists() || !atencionDoc.exists()) {
          throw new Error('La mesa o su atención ya no están disponibles.')
        }

        const mesaActual = mesaDoc.data() as Omit<Mesa, 'id'>
        const atencionActual = atencionDoc.data() as Atencion
        if (
          mesaActual.estado !== 'ocupada' ||
          mesaActual.atencionActivaId !== atencionActivaId ||
          atencionActual.mesaId !== mesaId ||
          atencionActual.estado !== 'abierta'
        ) {
          throw new Error('La mesa ya no tiene esa atención activa. Actualiza la selección.')
        }

        const productoIds = Object.keys(cantidadesPedido).sort()
        const productoDocs = await Promise.all(
          productoIds.map((productoId) => transaccion.get(doc(db, 'productos', productoId)))
        )
        const items = productoDocs.map((productoDoc, indice) => {
          const productoId = productoIds[indice]
          const cantidad = cantidadesPedido[productoId]
          if (!productoDoc.exists()) {
            throw new Error('Uno de los productos ya no está disponible.')
          }
          const producto = productoDoc.data() as Omit<Producto, 'id'>
          if (
            producto.activo !== true ||
            typeof producto.nombre !== 'string' ||
            !Number.isSafeInteger(centimosProducto(producto)) ||
            centimosProducto(producto) < 0 ||
            !Number.isInteger(cantidad) ||
            cantidad < 1
          ) {
            throw new Error('Un producto cambió o tiene datos inválidos. Actualiza el catálogo.')
          }
          const precioUnitarioCentimos = centimosProducto(producto)
          const subtotalCentimos = precioUnitarioCentimos * cantidad
          if (!Number.isSafeInteger(subtotalCentimos)) {
            throw new Error('El subtotal de uno de los productos supera el monto admitido.')
          }
          return {
            productoId,
            nombre: producto.nombre,
            precioUnitarioCentimos,
            cantidad,
            subtotalCentimos,
          }
        })

        const totalCentimosPedido = items.reduce((suma, item) => suma + item.subtotalCentimos, 0)
        if (!Number.isSafeInteger(totalCentimosPedido)) {
          throw new Error('El total del pedido supera el monto admitido.')
        }
        const totalPedido = totalCentimosPedido / 100
        const totalAnteriorCentimos = Number.isSafeInteger(atencionActual.totalCentimos)
          ? atencionActual.totalCentimos!
          : Math.round(Number(atencionActual.total ?? 0) * 100)
        const nuevoTotalCentimos = totalAnteriorCentimos + totalCentimosPedido
        if (!Number.isSafeInteger(totalAnteriorCentimos) || !Number.isSafeInteger(nuevoTotalCentimos)) {
          throw new Error('El total acumulado de la atención no es válido.')
        }
        const nuevoTotal = nuevoTotalCentimos / 100

        transaccion.set(pedidoRef, {
          atencionId: atencionActivaId,
          mesaId,
          mesaNumero: mesaActual.numero,
          creadoPor: uid,
          creadoEn: serverTimestamp(),
          estado: 'recibido',
          items,
          total: totalPedido,
          totalCentimos: totalCentimosPedido,
        })
        transaccion.update(atencionRef, {
          total: nuevoTotal,
          totalCentimos: nuevoTotalCentimos,
          ultimoPedidoId: pedidoRef.id,
        })

        return { repetido: false, totalPedido, totalAtencion: nuevoTotal }
      })

      pedidoPendiente.current = null
      setCantidades({})
      setMensaje(
        resultado.repetido
          ? `Este pedido ya estaba guardado (${soles(resultado.totalPedido)}). Total de atención: ${soles(resultado.totalAtencion)}.`
          : `Pedido guardado (${soles(resultado.totalPedido)}). Total de atención: ${soles(resultado.totalAtencion)}.`
      )
    } catch (err) {
      console.error('Error al guardar pedido:', err)
      setError(err instanceof Error ? err.message : 'No se pudo guardar el pedido.')
    } finally {
      setGuardando(false)
    }
  }

  const mesasConAtencion = mesas.filter((mesa) => typeof mesa.atencionActivaId === 'string' && mesa.atencionActivaId.length > 0)

  return (
    <section className="pedidos-seccion">
      <div className="pedidos-titulo">
        <h2>Gestión de Pedidos</h2>
        <p>Agrega productos a la atención activa de una mesa ocupada.</p>
      </div>

      {mensaje && <p className="pedidos-mensaje" role="status">{mensaje}</p>}
      {error && <p className="pedidos-error" role="alert">{error}</p>}

      <label className="pedido-mesa-selector">
        Mesa ocupada
        <select
          value={mesaSeleccionadaId}
          onChange={(evento) => cambiarMesa(evento.target.value)}
          disabled={guardando}
        >
          <option value="">Selecciona una mesa</option>
          {mesasConAtencion.map((mesa) => (
            <option key={mesa.id} value={mesa.id}>
              Mesa {String(mesa.numero).padStart(2, '0')} · {mesa.comensales ?? '—'} comensales
            </option>
          ))}
        </select>
      </label>

      {cargandoMesas && <p>Cargando mesas…</p>}
      {!cargandoMesas && mesas.length === 0 && <p>No hay mesas ocupadas.</p>}
      {!cargandoMesas && mesas.length > 0 && mesasConAtencion.length === 0 && (
        <p>Las mesas ocupadas no tienen una atención activa vinculada.</p>
      )}

      {mesaSeleccionada && (
        <div className="pedido-atencion-resumen">
          <strong>Mesa {String(mesaSeleccionada.numero).padStart(2, '0')}</strong>
          <span>Atención: {atencionActivaId || 'sin vínculo'}</span>
          <span>Comensales: {atencion?.comensales ?? mesaSeleccionada.comensales ?? '—'}</span>
          <span>Total acumulado: {soles(atencion?.total ?? 0)}</span>
        </div>
      )}

      <div className="pedido-contenido">
        <div className="pedido-catalogo">
          <h3>Productos activos</h3>
          {cargandoProductos && <p>Cargando productos…</p>}
          {!cargandoProductos && productos.length === 0 && <p>No hay productos activos en el catálogo.</p>}
          {productos.map((producto) => (
            <article className="pedido-producto" key={producto.id}>
              <div>
                <strong>{producto.nombre}</strong>
              <span>{producto.categoria} · {soles(centimosProducto(producto) / 100)}</span>
              </div>
              <button
                type="button"
                onClick={() => cambiarCantidad(producto.id, (cantidades[producto.id] ?? 0) + 1)}
                disabled={guardando || !mesaSeleccionada || !atencion}
              >
                Agregar
              </button>
            </article>
          ))}
        </div>

        <div className="pedido-carrito">
          <h3>Pedido actual</h3>
          {lineas.length === 0 && <p>Aún no agregas productos.</p>}
          {productosNoDisponibles.map((productoId) => (
            <div className="pedido-linea" key={productoId}>
              <strong>Producto ya no activo</strong>
              <button
                type="button"
                className="pedido-quitar"
                onClick={() => cambiarCantidad(productoId, 0)}
                disabled={guardando}
              >
                Quitar
              </button>
            </div>
          ))}
          {lineas.map(({ producto, cantidad, subtotal }) => (
            <div className="pedido-linea" key={producto.id}>
              <div>
                <strong>{producto.nombre}</strong>
                <span>{soles(centimosProducto(producto) / 100)} c/u · Subtotal {soles(subtotal)}</span>
              </div>
              <input
                aria-label={`Cantidad de ${producto.nombre}`}
                type="number"
                min="1"
                step="1"
                value={cantidad}
                disabled={guardando}
                onChange={(evento) => {
                  const nuevaCantidad = Number(evento.target.value)
                  if (evento.target.value === '' || !Number.isSafeInteger(nuevaCantidad) || nuevaCantidad < 1 || nuevaCantidad > 1000000) return
                  cambiarCantidad(producto.id, nuevaCantidad)
                }}
              />
              <button
                type="button"
                className="pedido-quitar"
                onClick={() => cambiarCantidad(producto.id, 0)}
                disabled={guardando}
              >
                Quitar
              </button>
            </div>
          ))}

          <div className="pedido-total">
            <strong>Total del pedido</strong>
            <strong>{soles(totalMostrado)}</strong>
          </div>
          <button
            type="button"
            className="pedido-guardar"
            onClick={guardarPedido}
            disabled={guardando || lineas.length === 0 || !atencion}
          >
            {guardando ? 'Guardando pedido…' : 'Guardar pedido'}
          </button>
        </div>
      </div>
    </section>
  )
}

export default GestionPedidos
