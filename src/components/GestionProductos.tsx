import { useEffect, useState, type FormEvent } from 'react'
import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import { guardarProductoUnico, ProductoDuplicadoError } from './productosUtils'

type Producto = {
  id: string
  nombre: string
  categoria: string
  presentacion?: string
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
  presentacion: '',
  precio: '',
  activo: true,
}

const categorias = ['Pollos', 'Acompañamientos', 'Bebidas frías', 'Bebidas calientes']
const presentacionesRapidas: Record<string, string[]> = {
  Pollos: ['1/8', '1/4', '1/2', 'Entero'],
  'Bebidas frías': ['500 ml', '1 litro', '1.5 litros', '2 litros'],
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
      presentacion: producto.presentacion ?? '',
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
    if (cargando) {
      setError('Espera a que termine de cargar el catálogo antes de guardar.')
      return
    }

    const nombre = formulario.nombre.trim()
    const categoria = formulario.categoria.trim()
    const presentacion = formulario.presentacion.trim()
    const precio = Number(formulario.precio)

    if (!nombre || !categoria) {
      setError('Ingresa el nombre y la categoría del producto.')
      return
    }

    if ((categoria === 'Bebidas frías' || categoria === 'Bebidas calientes') && !presentacion) {
      setError('Ingresa la presentación de la bebida, por ejemplo 500 ml, botella o taza.')
      return
    }
    if (presentacion.length > 60) {
      setError('La presentación no puede superar 60 caracteres.')
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
      const datos: Omit<Producto, 'id' | 'precio'> & { precio: number } = {
        nombre,
        categoria,
        precio: precioCentimos / 100,
        precioCentimos,
        activo: formulario.activo,
      }
      if (presentacion) datos.presentacion = presentacion
      await guardarProductoUnico(db, datos, productos, productoEditando ?? undefined)
      setMensaje(productoEditando ? 'Producto actualizado.' : 'Producto registrado.')

      setProductoEditando(null)
      setFormulario(formularioInicial)
    } catch (err) {
      console.error('Error al guardar producto:', err)
      setError(err instanceof ProductoDuplicadoError
        ? err.message
        : 'No se pudo guardar el producto. Revisa los permisos de Firestore y vuelve a intentarlo.')
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
          <select
            value={formulario.categoria}
            onChange={(evento) => setFormulario({ ...formulario, categoria: evento.target.value })}
            required
          >
            <option value="">Selecciona una categoría</option>
            {categorias.map((categoria) => <option key={categoria} value={categoria}>{categoria}</option>)}
            {formulario.categoria && !categorias.includes(formulario.categoria) && (
              <option value={formulario.categoria}>{formulario.categoria} (existente)</option>
            )}
          </select>
        </label>

        <label>
          Presentación
          <input
            value={formulario.presentacion}
            onChange={(evento) => setFormulario({ ...formulario, presentacion: evento.target.value })}
            maxLength={60}
            list="presentaciones-rapidas"
            placeholder="Elige una opción o escribe otra"
          />
          <datalist id="presentaciones-rapidas">
            {(presentacionesRapidas[formulario.categoria] ?? []).map((presentacion) => (
              <option key={presentacion} value={presentacion} />
            ))}
          </datalist>
          <small>Las presentaciones distintas se registran como productos separados y pueden tener precios propios.</small>
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
                  <th>Producto</th>
                  <th>Categoría</th>
                  <th>Precio</th>
                  <th>Estado</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {productos.map((producto) => (
                  <tr key={producto.id}>
                    <td>
                      <strong>{producto.nombre}</strong>
                      <small className="producto-presentacion">{producto.presentacion || 'Sin presentación'}</small>
                    </td>
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
