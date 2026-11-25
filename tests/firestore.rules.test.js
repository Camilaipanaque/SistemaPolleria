import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, getDocs, collection, collectionGroup, query, where, limit, orderBy, Timestamp, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp, writeBatch } from 'firebase/firestore'
import {
  claveProductoNormalizada,
  guardarProductoUnico,
  idClaveProducto,
  normalizarPresentacion,
  ProductoDuplicadoError,
} from '../src/components/productosUtils.ts'

const projectId = 'demo-sistema-polleria'
let env

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') },
  })
})

after(async () => env?.cleanup())

beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, 'usuarios/admin'), { rol: 'administrador', activo: true })
    await setDoc(doc(db, 'usuarios/inactivo'), { rol: 'administrador', activo: false })
    await setDoc(doc(db, 'usuarios/cliente'), { rol: 'mozo', activo: true })
    await setDoc(doc(db, 'usuarios/cocinero'), { rol: 'cocina', activo: true })
    await setDoc(doc(db, 'usuarios/cocina-inactiva'), { rol: 'cocina', activo: false })
    await setDoc(doc(db, 'mesas/mesa-1'), {
      numero: 1, estado: 'ocupada', atencionActivaId: 'atencion-1', mozoId: 'admin',
    })
    await setDoc(doc(db, 'atenciones/atencion-1'), {
      mesaId: 'mesa-1', mesaNumero: 1, mozoId: 'admin', estado: 'abierta',
      total: 0, totalCentimos: 0,
    })
    // Legacy product: the rules and UI must continue to interpret `precio`.
    await setDoc(doc(db, 'productos/pollo'), {
      nombre: 'Pollo', categoria: 'Pollos', precio: 25, activo: true,
    })
    await setDoc(doc(db, 'productos/inactivo'), {
      nombre: 'Producto oculto', categoria: 'Extras', precio: 5, activo: false,
    })
    await setDoc(doc(db, 'productos/limonada'), {
      nombre: 'Limonada', categoria: 'Bebidas frías', presentacion: '500 ml',
      precio: 8, precioCentimos: 800, activo: true,
    })
    for (let i = 2; i <= 9; i += 1) {
      await setDoc(doc(db, `productos/p${i}`), {
        nombre: `Producto ${i}`, categoria: 'Extras', precioCentimos: i * 100,
        precio: i, activo: true,
      })
    }
  })
})

const lineaPollo = (overrides = {}) => ({
  productoId: 'pollo', nombre: 'Pollo', precioUnitarioCentimos: 2500,
  cantidad: 2, subtotalCentimos: 5000, ...overrides,
})

const lineaLimonada = (overrides = {}) => ({
  productoId: 'limonada', nombre: 'Limonada', presentacion: '500 ml',
  precioUnitarioCentimos: 800, cantidad: 2, subtotalCentimos: 1600, ...overrides,
})

function pedido(db, id, options = {}) {
  const items = options.items ?? [lineaPollo()]
  const totalCentimos = options.totalCentimos ?? items.reduce((sum, item) => sum + item.subtotalCentimos, 0)
  const total = options.total ?? totalCentimos / 100
  return runTransaction(db, async (tx) => {
    const atencionRef = doc(db, 'atenciones/atencion-1')
    const atencion = (await tx.get(atencionRef)).data()
    const pedidoRef = doc(db, `atenciones/atencion-1/pedidos/${id}`)
    tx.set(pedidoRef, {
      atencionId: 'atencion-1', mesaId: 'mesa-1', mesaNumero: 1,
      creadoPor: 'admin', creadoEn: serverTimestamp(), estado: 'recibido',
      items, total, totalCentimos,
    })
    tx.update(atencionRef, {
      total: atencion.total + total,
      totalCentimos: atencion.totalCentimos + totalCentimos,
      ultimoPedidoId: id,
    })
  })
}

function pedidoConComanda(db, id, options = {}) {
  const items = options.items ?? [lineaPollo()]
  const totalCentimos = items.reduce((sum, item) => sum + item.subtotalCentimos, 0)
  const total = totalCentimos / 100
  return runTransaction(db, async (tx) => {
    const atencionRef = doc(db, 'atenciones/atencion-1')
    const atencion = (await tx.get(atencionRef)).data()
    const pedidoRef = doc(db, `atenciones/atencion-1/pedidos/${id}`)
    tx.set(pedidoRef, {
      atencionId: 'atencion-1', mesaId: 'mesa-1', mesaNumero: 1,
      creadoPor: 'admin', creadoEn: serverTimestamp(), estado: 'recibido',
      items, ...(options.observaciones ? { observaciones: options.observaciones } : {}), total, totalCentimos,
    })
    tx.set(doc(pedidoRef, 'cocina', 'resumen'), {
      atencionId: 'atencion-1', pedidoId: id, mesaId: 'mesa-1', mesaNumero: 1,
      creadoPor: 'admin', creadoEn: serverTimestamp(), estado: 'recibido',
      items: items.map(({ productoId, nombre, presentacion, cantidad }) => ({
        productoId, nombre, ...(presentacion ? { presentacion } : {}), cantidad,
      })),
      ...(options.observaciones ? { observaciones: options.observaciones } : {}),
    })
    tx.update(atencionRef, {
      total: atencion.total + total,
      totalCentimos: atencion.totalCentimos + totalCentimos,
      ultimoPedidoId: id,
    })
  })
}

function cambiarEstadoCocina(db, id, estado) {
  const batch = writeBatch(db)
  const pedidoRef = doc(db, `atenciones/atencion-1/pedidos/${id}`)
  batch.update(pedidoRef, { estado })
  batch.update(doc(pedidoRef, 'cocina', 'resumen'), { estado })
  return batch.commit()
}

function cobrar(db, id, options = {}) {
  const atencionRef = doc(db, 'atenciones/atencion-1')
  const mesaRef = doc(db, 'mesas/mesa-1')
  const pagoRef = doc(db, `atenciones/atencion-1/pagos/${id}`)
  return runTransaction(db, async (tx) => {
    const atencionSnap = await tx.get(atencionRef)
    const atencion = atencionSnap.data()
    const saldo = Number.isSafeInteger(atencion.totalCentimos)
      ? atencion.totalCentimos
      : Math.round(atencion.total * 100)
    const importeCentimos = options.importeCentimos ?? saldo
    const metodo = options.metodo ?? 'efectivo'
    tx.set(pagoRef, {
      metodo, importeCentimos, importe: importeCentimos / 100,
      registradoEn: serverTimestamp(), confirmadoPor: options.confirmadoPor ?? 'admin',
    })
    tx.update(atencionRef, {
      estado: 'cerrada', cierre: serverTimestamp(), metodoPago: metodo,
      pagoId: id, totalPagadoCentimos: importeCentimos,
    })
    tx.update(mesaRef, {
      estado: 'libre', atencionActivaId: null, mozoId: null,
      mozoNombre: null, comensales: null, inicioAtencion: null,
    })
  })
}

test('administrador activo autorizado puede leer productos y atención', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(getDoc(doc(db, 'productos/pollo')))
  await assertSucceeds(getDoc(doc(db, 'atenciones/atencion-1')))
})

test('producto antiguo con categoría heredada cumple el formato de catálogo', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(setDoc(doc(db, 'productos/producto-antiguo'), {
    nombre: 'Porción antigua', categoria: 'Extras', precio: 5, precioCentimos: 500, activo: true,
  }))
})

test('bebida nueva exige una presentación válida', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(setDoc(doc(db, 'productos/te-caliente'), {
    nombre: 'Té', categoria: 'Bebidas calientes', presentacion: 'taza',
    precio: 4, precioCentimos: 400, activo: true,
  }))
  await assertFails(setDoc(doc(db, 'productos/bebida-sin-presentacion'), {
    nombre: 'Chicha', categoria: 'Bebidas frías', precio: 6, precioCentimos: 600, activo: true,
  }))
  await assertFails(setDoc(doc(db, 'productos/bebida-presentacion-invalida'), {
    nombre: 'Chicha', categoria: 'Bebidas frías', presentacion: '',
    precio: 6, precioCentimos: 600, activo: true,
  }))
})

test('normaliza mayúsculas, espacios, fracciones y equivalencias de volumen', () => {
  assert.equal(normalizarPresentacion('  1.5   LITROS '), normalizarPresentacion('1500 ml'))
  assert.equal(normalizarPresentacion('1 litro'), normalizarPresentacion('1000 ML'))
  assert.equal(normalizarPresentacion('½'), normalizarPresentacion('1 / 2'))
  assert.equal(claveProductoNormalizada({ nombre: '  Coca   Cola ', categoria: 'Bebidas frías', presentacion: '500 ml' }),
    claveProductoNormalizada({ nombre: 'coca cola', categoria: 'BEBIDAS FRÍAS', presentacion: '0.5 litros' }))
  assert.notEqual(claveProductoNormalizada({ nombre: 'Coca Cola', categoria: 'Bebidas frías', presentacion: '500 ml' }),
    claveProductoNormalizada({ nombre: 'Pepsi', categoria: 'Bebidas frías', presentacion: '500 ml' }))
})

test('productos con presentaciones diferentes mantienen precios independientes', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(setDoc(doc(db, 'productos/gaseosa-500'), {
    nombre: 'Coca Cola', categoria: 'Bebidas frías', presentacion: '500 ml',
    precio: 3, precioCentimos: 300, activo: true,
  }))
  await assertSucceeds(setDoc(doc(db, 'productos/gaseosa-2l'), {
    nombre: 'Coca Cola', categoria: 'Bebidas frías', presentacion: '2 litros',
    precio: 10, precioCentimos: 1000, activo: true,
  }))
  assert.equal((await getDoc(doc(db, 'productos/gaseosa-500'))).data().precioCentimos, 300)
  assert.equal((await getDoc(doc(db, 'productos/gaseosa-2l'))).data().precioCentimos, 1000)
})

test('alta bloquea combinaciones duplicadas considerando legado y normalización', async () => {
  const db = env.authenticatedContext('admin').firestore()
  const existente = await getDocs(collection(db, 'productos'))
  const productos = existente.docs.map((registro) => ({ id: registro.id, ...registro.data() }))
  await assert.rejects(guardarProductoUnico(db, {
    nombre: ' pollo ', categoria: ' POLLOS ', precio: 25, precioCentimos: 2500, activo: true,
  }, productos), ProductoDuplicadoError)
  await assertSucceeds(guardarProductoUnico(db, {
    nombre: 'Gaseosa Marca X', categoria: 'Bebidas frías', presentacion: '1 litro',
    precio: 5, precioCentimos: 500, activo: true,
  }, productos))
})

test('edición rechaza chocar con otra presentación existente y conserva el documento', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(setDoc(doc(db, 'productos/pollo-1-8'), {
    nombre: 'Pollo a la brasa', categoria: 'Pollos', presentacion: '1/8',
    precio: 12, precioCentimos: 1200, activo: true,
  }))
  await assertSucceeds(setDoc(doc(db, 'productos/pollo-1-4'), {
    nombre: 'Pollo a la brasa', categoria: 'Pollos', presentacion: '1/4',
    precio: 22, precioCentimos: 2200, activo: true,
  }))
  const registros = await getDocs(collection(db, 'productos'))
  const productos = registros.docs.map((registro) => ({ id: registro.id, ...registro.data() }))
  await assert.rejects(guardarProductoUnico(db, {
    nombre: 'Pollo a la brasa', categoria: 'Pollos', presentacion: '¼',
    precio: 23, precioCentimos: 2300, activo: true,
  }, productos, 'pollo-1-8'), ProductoDuplicadoError)
  assert.equal((await getDoc(doc(db, 'productos/pollo-1-8'))).data().presentacion, '1/8')
})

test('dos altas simultáneas con la misma combinación solo registran una', async () => {
  const db = env.authenticatedContext('admin').firestore()
  const datos = {
    nombre: 'Gaseosa Marca Y', categoria: 'Bebidas frías', presentacion: '1.5 litros',
    precio: 7, precioCentimos: 700, activo: true,
  }
  const resultados = await Promise.allSettled([
    guardarProductoUnico(db, datos, []),
    guardarProductoUnico(db, { ...datos, presentacion: '1500 ml' }, []),
  ])
  assert.equal(resultados.filter((resultado) => resultado.status === 'fulfilled').length, 1)
  assert.equal(resultados.filter((resultado) => resultado.status === 'rejected').length, 1)
  const catalogo = await getDocs(query(collection(db, 'productos'), where('nombre', '==', 'Gaseosa Marca Y')))
  assert.equal(catalogo.size, 1)
  const claveRef = doc(db, 'clavesProductos', await idClaveProducto(datos))
  const clave = await assertSucceeds(getDoc(claveRef))
  assert.equal(clave.data().productoId, catalogo.docs[0].id)
})

test('administrador activo puede ejecutar consulta collectionGroup de pagos por fecha', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-grupo'))
  await assertSucceeds(cobrar(db, 'pago-grupo'))
  const q = query(collectionGroup(db, 'pagos'), where('registradoEn', '>=', Timestamp.fromDate(new Date(0))), limit(50))
  const pagos = await assertSucceeds(getDocs(q))
  assert.equal(pagos.size, 1)
  await assertFails(getDocs(query(collectionGroup(db, 'pagos'), where('registradoEn', '>=', Timestamp.fromDate(new Date(0))))))
})

test('administrador inactivo y usuario no autorizado no pueden consultar collectionGroup pagos', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'atenciones/atencion-1/pagos/pago-semilla'), {
      metodo: 'efectivo', importeCentimos: 0, importe: 0,
      registradoEn: Timestamp.fromDate(new Date()), confirmadoPor: 'admin',
    })
  })
  for (const context of [env.authenticatedContext('inactivo'), env.authenticatedContext('cliente'), env.unauthenticatedContext()]) {
    const q = query(collectionGroup(context.firestore(), 'pagos'), where('registradoEn', '>=', Timestamp.fromDate(new Date(0))), limit(50))
    await assertFails(getDocs(q))
  }
})

test('el listado global de atenciones sigue prohibido', async () => {
  await assertFails(getDocs(collection(env.authenticatedContext('admin').firestore(), 'atenciones')))
})

test('solo se pueden listar pedidos de una atención cerrada y pagada', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-ticket'))
  await assertSucceeds(cobrar(db, 'pago-ticket'))
  await assertSucceeds(getDocs(collection(db, 'atenciones/atencion-1/pedidos')))
})

test('usuario no autorizado no puede listar pedidos ni de atención pagada', async () => {
  const adminDb = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(adminDb, 'pedido-ticket'))
  await assertSucceeds(cobrar(adminDb, 'pago-ticket'))
  await assertFails(getDocs(collection(env.authenticatedContext('cliente').firestore(), 'atenciones/atencion-1/pedidos')))
})

test('administrador no puede listar pedidos de atención abierta', async () => {
  await assertFails(getDocs(collection(env.authenticatedContext('admin').firestore(), 'atenciones/atencion-1/pedidos')))
})

test('atención cerrada sin el documento de pago no permite listar pedidos', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'atenciones/atencion-1'), {
      mesaId: 'mesa-1', mesaNumero: 1, estado: 'cerrada', total: 0, totalCentimos: 0,
      totalPagadoCentimos: 0, metodoPago: 'efectivo', pagoId: 'pago-ausente',
    })
  })
  await assertFails(getDocs(collection(env.authenticatedContext('admin').firestore(), 'atenciones/atencion-1/pedidos')))
})

test('usuario sin rol de administrador no puede leer catálogo ni crear pedidos', async () => {
  const db = env.authenticatedContext('cliente').firestore()
  await assertFails(getDoc(doc(db, 'productos/pollo')))
  await assertFails(pedido(db, 'no-autorizado'))
})

test('pedido válido y total acumulado en atención se acepta', async () => {
  await assertSucceeds(pedido(env.authenticatedContext('admin').firestore(), 'pedido-valido'))
})

test('pedido nuevo guarda la presentación del catálogo y conserva línea histórica', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-bebida', { items: [lineaLimonada()] }))
  await assertSucceeds(pedido(db, 'pedido-historico-sin-presentacion'))
})

test('la línea nueva debe copiar presentación y no admite campos adicionales', async () => {
  const db = env.authenticatedContext('admin').firestore()
  const { presentacion: _presentacion, ...sinPresentacion } = lineaLimonada()
  await assertFails(pedido(db, 'presentacion-faltante', {
    items: [sinPresentacion], total: 16, totalCentimos: 1600,
  }))
  await assertFails(pedido(db, 'presentacion-manipulada', {
    items: [lineaLimonada({ presentacion: '1.5 L' })], total: 16, totalCentimos: 1600,
  }))
  await assertFails(pedido(db, 'campo-no-validado', {
    items: [lineaLimonada({ desconocido: true })], total: 16, totalCentimos: 1600,
  }))
})

test('cocina lee comandas sin precios y no puede leer datos financieros', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedidoConComanda(admin, 'pedido-privado', {
    items: [lineaLimonada()], observaciones: 'Salsa aparte',
  }))
  const cocina = env.authenticatedContext('cocinero').firestore()
  await assertSucceeds(getDoc(doc(cocina, 'atenciones/atencion-1/pedidos/pedido-privado/cocina/resumen')))
  const listaDirecta = query(collection(cocina, 'atenciones/atencion-1/pedidos/pedido-privado/cocina'), where('estado', 'in', ['recibido', 'preparando', 'listo']), limit(200))
  await assertSucceeds(getDocs(listaDirecta))
  const consulta = query(collectionGroup(cocina, 'cocina'), where('estado', '==', 'recibido'), orderBy('creadoEn', 'asc'), limit(200))
  const resultados = await assertSucceeds(getDocs(consulta))
  assert.equal(resultados.size, 1)
  const comanda = resultados.docs[0].data()
  assert.equal(comanda.observaciones, 'Salsa aparte')
  assert.equal(comanda.items[0].presentacion, '500 ml')
  assert.equal('totalCentimos' in comanda, false)
  assert.equal('precioUnitarioCentimos' in comanda.items[0], false)
  await assertFails(getDoc(doc(cocina, 'atenciones/atencion-1/pedidos/pedido-privado')))
  await assertFails(getDoc(doc(cocina, 'atenciones/atencion-1')))
  await assertFails(getDoc(doc(cocina, 'productos/limonada')))
  await assertFails(getDoc(doc(cocina, 'atenciones/atencion-1/pagos/pago-secreto')))
  await assertFails(getDoc(doc(env.authenticatedContext('cocina-inactiva').firestore(), 'atenciones/atencion-1/pedidos/pedido-privado/cocina/resumen')))
  await assertFails(cambiarEstadoCocina(env.authenticatedContext('cocina-inactiva').firestore(), 'pedido-privado', 'preparando'))
})

test('cocina solo puede avanzar recibido a preparando y preparando a listo', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedidoConComanda(admin, 'pedido-estados'))
  const cocina = env.authenticatedContext('cocinero').firestore()
  await assertFails(cambiarEstadoCocina(cocina, 'pedido-estados', 'listo'))
  await assertSucceeds(cambiarEstadoCocina(cocina, 'pedido-estados', 'preparando'))
  await assertFails(cambiarEstadoCocina(cocina, 'pedido-estados', 'preparando'))
  await assertSucceeds(cambiarEstadoCocina(cocina, 'pedido-estados', 'listo'))
  await assertFails(cambiarEstadoCocina(cocina, 'pedido-estados', 'listo'))
})

test('pedido activo antiguo sin resumen permanece intacto y no aparece en Cocina', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(admin, 'pedido-antiguo-sin-comanda'))
  const cocina = env.authenticatedContext('cocinero').firestore()
  const consulta = query(collectionGroup(cocina, 'cocina'), where('estado', '==', 'recibido'), orderBy('creadoEn', 'asc'), limit(200))
  const resultados = await assertSucceeds(getDocs(consulta))
  assert.equal(resultados.size, 0)
  await assertFails(getDoc(doc(cocina, 'atenciones/atencion-1/pedidos/pedido-antiguo-sin-comanda')))
  await assertFails(cambiarEstadoCocina(cocina, 'pedido-antiguo-sin-comanda', 'preparando'))
})

test('mozo puede consultar comandas para identificar pedidos listos sin leer pedidos financieros', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedidoConComanda(admin, 'pedido-para-mozo'))
  const mozo = env.authenticatedContext('cliente').firestore()
  const resumenRef = doc(mozo, 'atenciones/atencion-1/pedidos/pedido-para-mozo/cocina/resumen')
  await assertFails(getDoc(resumenRef))
  await assertFails(getDocs(query(collectionGroup(mozo, 'cocina'), where('estado', '==', 'recibido'), limit(200))))
  await assertSucceeds(cambiarEstadoCocina(env.authenticatedContext('cocinero').firestore(), 'pedido-para-mozo', 'preparando'))
  await assertSucceeds(cambiarEstadoCocina(env.authenticatedContext('cocinero').firestore(), 'pedido-para-mozo', 'listo'))
  const consulta = query(collectionGroup(mozo, 'cocina'), where('estado', '==', 'listo'), orderBy('creadoEn', 'asc'), limit(200))
  const resultados = await assertSucceeds(getDocs(consulta))
  assert.equal(resultados.docs[0].data().estado, 'listo')
  await assertSucceeds(getDoc(resumenRef))
  await assertFails(getDoc(doc(mozo, 'atenciones/atencion-1/pedidos/pedido-para-mozo')))
  await assertFails(cambiarEstadoCocina(mozo, 'pedido-para-mozo', 'preparando'))
})

test('mozo entrega solamente pedidos listos y se conservan fuera de la cola activa', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedidoConComanda(admin, 'pedido-entregado'))
  const cocina = env.authenticatedContext('cocinero').firestore()
  await assertSucceeds(cambiarEstadoCocina(cocina, 'pedido-entregado', 'preparando'))
  await assertSucceeds(cambiarEstadoCocina(cocina, 'pedido-entregado', 'listo'))
  const mozo = env.authenticatedContext('cliente').firestore()
  await assertFails(cambiarEstadoCocina(mozo, 'pedido-entregado', 'preparando'))
  await assertSucceeds(cambiarEstadoCocina(mozo, 'pedido-entregado', 'entregado'))
  await assertFails(cambiarEstadoCocina(mozo, 'pedido-entregado', 'entregado'))
  const pedidoGuardado = await assertSucceeds(getDoc(doc(admin, 'atenciones/atencion-1/pedidos/pedido-entregado')))
  const resumenGuardado = await assertSucceeds(getDoc(doc(admin, 'atenciones/atencion-1/pedidos/pedido-entregado/cocina/resumen')))
  assert.equal(pedidoGuardado.data().estado, 'entregado')
  assert.equal(resumenGuardado.data().estado, 'entregado')
  assert.equal(pedidoGuardado.data().totalCentimos, 5000)
  const cola = await assertSucceeds(getDocs(query(collectionGroup(mozo, 'cocina'), where('estado', '==', 'listo'), orderBy('creadoEn', 'asc'), limit(200))))
  assert.equal(cola.size, 0)
  await assertSucceeds(cobrar(admin, 'pago-despues-entrega'))
  const pedidosPagados = await assertSucceeds(getDocs(collection(admin, 'atenciones/atencion-1/pedidos')))
  assert.equal(pedidosPagados.docs.find((docPedido) => docPedido.id === 'pedido-entregado').data().totalCentimos, 5000)
})

test('mozo no puede entregar un pedido pendiente ni Cocina completar la entrega', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedidoConComanda(admin, 'pedido-no-listo'))
  const mozo = env.authenticatedContext('cliente').firestore()
  await assertFails(cambiarEstadoCocina(mozo, 'pedido-no-listo', 'entregado'))
  const cocina = env.authenticatedContext('cocinero').firestore()
  await assertFails(cambiarEstadoCocina(cocina, 'pedido-no-listo', 'entregado'))
})

test('entregas concurrentes de la misma comanda solo permiten una transición', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedidoConComanda(admin, 'pedido-concurrente'))
  const cocina = env.authenticatedContext('cocinero').firestore()
  await assertSucceeds(cambiarEstadoCocina(cocina, 'pedido-concurrente', 'preparando'))
  await assertSucceeds(cambiarEstadoCocina(cocina, 'pedido-concurrente', 'listo'))
  const mozoA = env.authenticatedContext('cliente').firestore()
  const mozoB = env.authenticatedContext('cliente').firestore()
  const resultados = await Promise.allSettled([
    cambiarEstadoCocina(mozoA, 'pedido-concurrente', 'entregado'),
    cambiarEstadoCocina(mozoB, 'pedido-concurrente', 'entregado'),
  ])
  assert.equal(resultados.filter((resultado) => resultado.status === 'fulfilled').length, 1)
  assert.equal(resultados.filter((resultado) => resultado.status === 'rejected').length, 1)
  const pedidoFinal = await assertSucceeds(getDoc(doc(admin, 'atenciones/atencion-1/pedidos/pedido-concurrente')))
  const resumenFinal = await assertSucceeds(getDoc(doc(admin, 'atenciones/atencion-1/pedidos/pedido-concurrente/cocina/resumen')))
  assert.equal(pedidoFinal.data().estado, 'entregado')
  assert.equal(resumenFinal.data().estado, 'entregado')
})

test('transición con resumen desincronizado se rechaza', async () => {
  const admin = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedidoConComanda(admin, 'pedido-desincronizado'))
  await env.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), 'atenciones/atencion-1/pedidos/pedido-desincronizado/cocina/resumen'), { estado: 'preparando' })
  })
  await assertFails(cambiarEstadoCocina(env.authenticatedContext('cocinero').firestore(), 'pedido-desincronizado', 'preparando'))
})

test('precio manipulado contra el catálogo se rechaza', async () => {
  await assertFails(pedido(env.authenticatedContext('admin').firestore(), 'precio-falso', {
    items: [lineaPollo({ precioUnitarioCentimos: 100, subtotalCentimos: 200 })],
    total: 2, totalCentimos: 200,
  }))
})

test('producto inactivo no puede incluirse en pedido', async () => {
  await assertFails(pedido(env.authenticatedContext('admin').firestore(), 'producto-inactivo', {
    items: [lineaPollo({
      productoId: 'inactivo', nombre: 'Producto oculto', precioUnitarioCentimos: 500,
      cantidad: 1, subtotalCentimos: 500,
    })],
  }))
})

test('no se puede crear dos veces el mismo ID de pedido', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-unico'))
  await assertFails(pedido(db, 'pedido-unico'))
})

test('cantidad cero o fraccionaria se rechaza', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertFails(pedido(db, 'cantidad-cero', {
    items: [lineaPollo({ cantidad: 0, subtotalCentimos: 0 })], total: 0, totalCentimos: 0,
  }))
  await assertFails(pedido(db, 'cantidad-fraccionaria', {
    items: [lineaPollo({ cantidad: 1.5, subtotalCentimos: 3750 })], total: 37.5, totalCentimos: 3750,
  }))
})

test('subtotal distinto del precio por cantidad se rechaza', async () => {
  await assertFails(pedido(env.authenticatedContext('admin').firestore(), 'subtotal-incorrecto', {
    items: [lineaPollo({ subtotalCentimos: 4999 })], total: 49.99, totalCentimos: 4999,
  }))
})

test('total del pedido distinto de la suma de subtotales se rechaza', async () => {
  await assertFails(pedido(env.authenticatedContext('admin').firestore(), 'total-manipulado', {
    items: [lineaPollo()], total: 49.99, totalCentimos: 4999,
  }))
})

function lineasCatalogo(ids) {
  return ids.map((i) => ({
    productoId: `p${i}`, nombre: `Producto ${i}`, precioUnitarioCentimos: i * 100,
    cantidad: 1, subtotalCentimos: i * 100,
  }))
}

test('seis líneas exceden el máximo y se rechazan', async () => {
  const items = lineasCatalogo([2, 3, 4, 5, 6])
  items.push({ productoId: 'pollo', nombre: 'Pollo', precioUnitarioCentimos: 2500, cantidad: 1, subtotalCentimos: 2500 })
  await assertFails(pedido(env.authenticatedContext('admin').firestore(), 'seis-lineas', { items }))
})

test('líneas duplicadas del mismo producto se rechazan', async () => {
  await assertFails(pedido(env.authenticatedContext('admin').firestore(), 'producto-duplicado', {
    items: [lineaPollo({ cantidad: 1, subtotalCentimos: 2500 }), lineaPollo({ cantidad: 1, subtotalCentimos: 2500 })],
  }))
})

test('se aceptan cuatro líneas válidas bajo el presupuesto de reglas', async () => {
  const items = lineasCatalogo([2, 3, 4])
  items.push(lineaPollo({ cantidad: 1, subtotalCentimos: 2500 }))
  await assertSucceeds(pedido(env.authenticatedContext('admin').firestore(), 'cuatro-lineas', { items }))
})

test('resumen de Cocina acepta cuatro productos y rechaza cinco atómicamente', async () => {
  const db = env.authenticatedContext('admin').firestore()
  const cuatro = lineasCatalogo([2, 3, 4])
  cuatro.push(lineaPollo({ cantidad: 1, subtotalCentimos: 2500 }))
  await assertSucceeds(pedidoConComanda(db, 'comanda-cuatro-items', { items: cuatro }))
  const cinco = lineasCatalogo([2, 3, 4, 5])
  cinco.push(lineaPollo({ cantidad: 1, subtotalCentimos: 2500 }))
  await assertFails(pedidoConComanda(db, 'comanda-cinco-items', { items: cinco }))
  const pedidoFallido = await assertSucceeds(getDoc(doc(db, 'atenciones/atencion-1/pedidos/comanda-cinco-items')))
  assert.equal(pedidoFallido.exists(), false)
})

test('total de atención manipulado sin coincidir con el pedido se rechaza', async () => {
  const db = env.authenticatedContext('admin').firestore()
  const ref = doc(db, 'atenciones/atencion-1')
  await assertFails(runTransaction(db, async (tx) => {
    tx.update(ref, { total: 0.01, totalCentimos: 1, ultimoPedidoId: 'fantasma' })
  }))
})

test('administrador confirma pago Yape, cierra atención y libera mesa atómicamente', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-para-cobrar'))
  await assertSucceeds(cobrar(db, 'pago-yape', { metodo: 'yape' }))
  const pago = (await getDoc(doc(db, 'atenciones/atencion-1/pagos/pago-yape'))).data()
  const atencion = (await getDoc(doc(db, 'atenciones/atencion-1'))).data()
  const mesa = (await getDoc(doc(db, 'mesas/mesa-1'))).data()
  assert.equal(pago.metodo, 'yape')
  assert.equal(pago.importeCentimos, 5000)
  assert.equal(pago.confirmadoPor, 'admin')
  assert.equal(atencion.estado, 'cerrada')
  assert.equal(atencion.totalPagadoCentimos, 5000)
  assert.equal(mesa.estado, 'libre')
  assert.equal(mesa.atencionActivaId, null)
})

test('importe distinto del total real de atención se rechaza', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-para-cobrar'))
  await assertFails(cobrar(db, 'pago-manipulado', { importeCentimos: 4999 }))
})

test('usuario no administrador no puede registrar pago ni cerrar mesa', async () => {
  const db = env.authenticatedContext('cliente').firestore()
  await assertFails(cobrar(db, 'pago-no-autorizado'))
})

test('administrador inactivo no puede leer atención individual', async () => {
  const db = env.authenticatedContext('inactivo').firestore()
  await assertFails(getDoc(doc(db, 'atenciones/atencion-1')))
})

test('administrador inactivo no puede registrar pago', async () => {
  const db = env.authenticatedContext('inactivo').firestore()
  await assertFails(setDoc(doc(db, 'atenciones/atencion-1/pagos/pago-inactivo'), {
    metodo: 'efectivo', importeCentimos: 0, importe: 0,
    registradoEn: serverTimestamp(), confirmadoPor: 'inactivo',
  }))
})

test('administrador inactivo no puede cerrar atención', async () => {
  const db = env.authenticatedContext('inactivo').firestore()
  await assertFails(updateDoc(doc(db, 'atenciones/atencion-1'), {
    estado: 'cerrada', cierre: serverTimestamp(), metodoPago: 'efectivo',
    pagoId: 'pago-no-autorizado', totalPagadoCentimos: 0,
  }))
})

test('administrador inactivo no puede liberar mesa', async () => {
  const db = env.authenticatedContext('inactivo').firestore()
  await assertFails(updateDoc(doc(db, 'mesas/mesa-1'), {
    estado: 'libre', atencionActivaId: null, mozoId: null,
    mozoNombre: null, comensales: null, inicioAtencion: null,
  }))
})

test('la atención cerrada no permite registrar un segundo pago', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-para-cobrar'))
  await assertSucceeds(cobrar(db, 'pago-primero'))
  await assertFails(cobrar(db, 'pago-duplicado'))
})

test('los pagos no se pueden modificar ni borrar', async () => {
  const db = env.authenticatedContext('admin').firestore()
  await assertSucceeds(pedido(db, 'pedido-inmutable'))
  await assertSucceeds(cobrar(db, 'pago-inmutable'))
  const ref = doc(db, 'atenciones/atencion-1/pagos/pago-inmutable')
  await assertFails(updateDoc(ref, { importeCentimos: 1 }))
  await assertFails(deleteDoc(ref))
})

test('cierre de atención sin crear el pago correspondiente se rechaza', async () => {
  const db = env.authenticatedContext('admin').firestore()
  const atencionRef = doc(db, 'atenciones/atencion-1')
  await assertFails(runTransaction(db, async (tx) => {
    tx.update(atencionRef, {
      estado: 'cerrada', cierre: serverTimestamp(), metodoPago: 'efectivo',
      pagoId: 'pago-ausente', totalPagadoCentimos: 0,
    })
  }))
})

test('pago completo acepta atención antigua sin totalCentimos', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'atenciones/atencion-1'), {
      mesaId: 'mesa-1', mesaNumero: 1, mozoId: 'admin', estado: 'abierta', total: 25,
    })
  })
  await assertSucceeds(cobrar(env.authenticatedContext('admin').firestore(), 'pago-legado'))
})
