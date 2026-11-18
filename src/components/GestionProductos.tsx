import { useEffect, useState, type FormEvent } from 'react'
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
} from 'firebase/firestore'
import { auth, db } from '../firebase'

type Producto = {
  id: string
  nombre: string
  categoria: string
  precio: number
  precioCentimos?: number
  activo: boolean
}

type GestionProductosProps = {
  usuarioId: string
}

const formularioInicial = {
  nombre: '',
  categoria: '',
  precio: '',
  activo: true,
}

function GestionProductos({ usuarioId }: GestionProductosProps) {
  const [productos, setProductos] = useState<Producto[]>([])
  const [formulario, setFormulario] = useState(formularioInicial)
  const [productoEditando, setProductoEditando] = useState<string | null>(null)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [mensaje, setMensaje] = useState('')

  useEffect(() => {
    const consulta = query(collection(db, 'productos'), orderBy('nombre', 'asc'))
    return onSnapshot(
      consulta,
      (resultado) => {
        setProductos(
          resultado.docs.map((documento) => {
            const datos = documento.data() as Omit<Producto, 'id'>
            return {
              id: documento.id,
              ...datos,
              // Read legacy products without changing Firestore data.
              precioCentimos: Number.isSafeInteger(datos.precioCentimos)
                ? datos.precioCentimos
                : Math.round((Number(datos.precio) + Number.EPSILON) * 100),
            }
          })
        )
        setCargando(false)
        setError('')
      },
      (err) => {
        console.error('Error al cargar productos:', err)
        setError('No se pudieron cargar los productos. Revisa los permisos de Firestore.')
        setCargando(false)
      }
    )
  }, [])

  function cancelarEdicion() {
    setProductoEditando(null)
    setFormulario(formularioInicial)
    setError('')
    setMensaje('')
  }

  function editarProducto(producto: Producto) {
    setProductoEditando(producto.id)
    setFormulario({
      nombre: producto.nombre,
      categoria: producto.categoria,
      precio: ((producto.precioCentimos ?? Math.round(producto.precio * 100)) / 100).toFixed(2),
      activo: producto.activo,
    })
    setError('')
    setMensaje('')
  }

  async function guardarProducto(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    setError('')
    setMensaje('')

    if (auth.currentUser?.uid !== usuarioId) {
      setError('La sesión actual no corresponde al usuario autenticado.')
      return
    }

    const nombre = formulario.nombre.trim()
    const categoria = formulario.categoria.trim()
    const precio = Number(formulario.precio)

    if (!nombre || !categoria) {
      setError('Ingresa el nombre y la categoría del producto.')
      return
    }

    if (!formulario.precio.trim() || !Number.isFinite(precio) || precio < 0) {
      setError('Ingresa un precio válido en soles, igual o mayor que cero.')
      return
    }

    const precioCentimos = Math.round((precio + Number.EPSILON) * 100)
    if (!Number.isSafeInteger(precioCentimos) || precioCentimos > 10000000000) {
      setError('El precio supera el monto permitido.')
      return
    }

    setGuardando(true)
    try {
      const datos = { nombre, categoria, precio: precioCentimos / 100, precioCentimos, activo: formulario.activo }

      if (productoEditando) {
        await updateDoc(doc(db, 'productos', productoEditando), datos)
        setMensaje('Producto actualizado.')
      } else {
        await addDoc(collection(db, 'productos'), datos)
        setMensaje('Producto registrado.')
      }

      setProductoEditando(null)
      setFormulario(formularioInicial)
    } catch (err) {
      console.error('Error al guardar producto:', err)
      setError('No se pudo guardar el producto. Revisa los permisos de Firestore.')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <section className="productos-seccion">
      <div className="productos-titulo">
        <div>
          <h2>Productos</h2>
          <p>Registra y mantiene el catálogo de tu pollería.</p>
        </div>
      </div>

      {mensaje && <p className="productos-mensaje" role="status">{mensaje}</p>}
      {error && <p className="productos-error" role="alert">{error}</p>}

      <form className="producto-formulario" onSubmit={guardarProducto}>
        <h3>{productoEditando ? 'Editar producto' : 'Registrar producto'}</h3>

        <label>
          Nombre
          <input
            value={formulario.nombre}
            onChange={(evento) => setFormulario({ ...formulario, nombre: evento.target.value })}
            maxLength={100}
            required
          />
        </label>

        <label>
          Categoría
          <input
            value={formulario.categoria}
            onChange={(evento) => setFormulario({ ...formulario, categoria: evento.target.value })}
            maxLength={60}
            required
          />
        </label>

        <label>
          Precio (S/)
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={formulario.precio}
            onChange={(evento) => setFormulario({ ...formulario, precio: evento.target.value })}
            required
          />
        </label>

        <label className="producto-activo">
          <input
            type="checkbox"
            checked={formulario.activo}
            onChange={(evento) => setFormulario({ ...formulario, activo: evento.target.checked })}
          />
          Activo
        </label>

        <div className="producto-formulario-acciones">
          <button type="submit" disabled={guardando}>
            {guardando ? 'Guardando…' : productoEditando ? 'Guardar cambios' : 'Registrar producto'}
          </button>
          {productoEditando && (
            <button type="button" className="producto-secundario" onClick={cancelarEdicion}>
              Cancelar
            </button>
          )}
        </div>
      </form>

      <div className="productos-lista">
        <h3>Catálogo</h3>
        {cargando && <p>Cargando productos…</p>}
        {!cargando && productos.length === 0 && (
          <p>El catálogo está vacío. Registra el primer producto cuando tengas sus datos.</p>
        )}
        {!cargando && productos.length > 0 && (
          <div className="productos-tabla-contenedor">
            <table className="productos-tabla">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Categoría</th>
                  <th>Precio</th>
                  <th>Estado</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {productos.map((producto) => (
                  <tr key={producto.id}>
                    <td>{producto.nombre}</td>
                    <td>{producto.categoria}</td>
                    <td>S/ {((producto.precioCentimos ?? Math.round(producto.precio * 100)) / 100).toFixed(2)}</td>
                    <td>{producto.activo ? 'Activo' : 'Inactivo'}</td>
                    <td>
                      <button type="button" onClick={() => editarProducto(producto)}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

export default GestionProductos
