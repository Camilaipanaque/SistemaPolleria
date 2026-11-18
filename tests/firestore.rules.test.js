import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, getDocs, collection, collectionGroup, query, where, limit, Timestamp, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp } from 'firebase/firestore'

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
    for (let i = 2; i <= 6; i += 1) {
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

test('cinco líneas también superan el límite seguro medido', async () => {
  const items = lineasCatalogo([2, 3, 4, 5])
  items.push({ productoId: 'pollo', nombre: 'Pollo', precioUnitarioCentimos: 2500, cantidad: 1, subtotalCentimos: 2500 })
  await assertFails(pedido(env.authenticatedContext('admin').firestore(), 'cinco-lineas', { items }))
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
