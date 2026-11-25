import {
  collection,
  doc,
  runTransaction,
  type Firestore,
} from 'firebase/firestore'

export type ProductoCatalogo = {
  id: string
  nombre: string
  categoria: string
  presentacion?: string
}

export type DatosProducto = Omit<ProductoCatalogo, 'id'> & Record<string, unknown>

function normalizarTexto(valor: string) {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es-PE')
}

export function normalizarPresentacion(presentacion = '') {
  const texto = normalizarTexto(presentacion)
    .replaceAll('⅛', '1/8')
    .replaceAll('¼', '1/4')
    .replaceAll('½', '1/2')
  const volumen = texto.match(/^(\d+(?:[.,]\d+)?)\s*(ml|cc|mililitro|mililitros|l|litro|litros)$/)
  if (volumen) {
    const cantidad = Number(volumen[1].replace(',', '.'))
    const mililitros = ['l', 'litro', 'litros'].includes(volumen[2])
      ? Math.round(cantidad * 1000)
      : Math.round(cantidad)
    if (Number.isSafeInteger(mililitros) && mililitros > 0) return `${mililitros} ml`
  }

  const fraccion = texto.replace(/\s+/g, '').match(/^1\/(8|4|2)$/)
  if (fraccion) return `porcion 1/${fraccion[1]}`
  if (['entero', 'entera', 'completo', 'completa'].includes(texto)) return 'porcion entero'
  return texto
}

export function claveProductoNormalizada(producto: Pick<ProductoCatalogo, 'nombre' | 'categoria' | 'presentacion'>) {
  return JSON.stringify([
    normalizarTexto(producto.nombre),
    normalizarTexto(producto.categoria),
    normalizarPresentacion(producto.presentacion),
  ])
}

export async function idClaveProducto(producto: Pick<ProductoCatalogo, 'nombre' | 'categoria' | 'presentacion'>) {
  const bytes = new TextEncoder().encode(claveProductoNormalizada(producto))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export class ProductoDuplicadoError extends Error {
  constructor() {
    super('Ya existe un producto con el mismo nombre, categoría y presentación. Revisa el catálogo antes de continuar.')
    this.name = 'ProductoDuplicadoError'
  }
}

export async function guardarProductoUnico(
  db: Firestore,
  datos: DatosProducto,
  productosExistentes: ProductoCatalogo[],
  productoId?: string,
) {
  const claveNormalizada = claveProductoNormalizada(datos)
  const duplicadoExistente = productosExistentes.some((producto) =>
    producto.id !== productoId && claveProductoNormalizada(producto) === claveNormalizada,
  )
  if (duplicadoExistente) throw new ProductoDuplicadoError()

  const productoRef = productoId
    ? doc(db, 'productos', productoId)
    : doc(collection(db, 'productos'))
  const claveId = await idClaveProducto(datos)
  const claveRef = doc(db, 'clavesProductos', claveId)

  await runTransaction(db, async (transaccion) => {
    const actualSnap = productoId ? await transaccion.get(productoRef) : null
    if (productoId && !actualSnap?.exists()) throw new Error('El producto que intentas editar ya no existe.')
    const actual = actualSnap?.data() as ProductoCatalogo | undefined
    const claveAnteriorId = actual ? await idClaveProducto(actual) : null
    const claveAnteriorRef = claveAnteriorId && claveAnteriorId !== claveId
      ? doc(db, 'clavesProductos', claveAnteriorId)
      : null
    const [claveNuevaSnap, claveAnteriorSnap] = await Promise.all([
      transaccion.get(claveRef),
      claveAnteriorRef ? transaccion.get(claveAnteriorRef) : Promise.resolve(null),
    ])

    if (claveNuevaSnap.exists() && claveNuevaSnap.data().productoId !== productoRef.id) {
      throw new ProductoDuplicadoError()
    }

    if (productoId) transaccion.update(productoRef, datos)
    else transaccion.set(productoRef, datos)
    transaccion.set(claveRef, { productoId: productoRef.id, claveNormalizada })
    if (claveAnteriorRef && claveAnteriorSnap?.exists()
      && claveAnteriorSnap.data().productoId === productoRef.id) {
      transaccion.delete(claveAnteriorRef)
    }
  })

  return productoRef.id
}
