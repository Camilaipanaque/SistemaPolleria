export type LineaConProductoId = {
  productoId: string
}

// Firestore Rules compares IDs with `<`, which uses binary string ordering.
// Keep the client order identical; localeCompare can order mixed-case IDs differently.
export function ordenarLineasPorProductoId<T extends LineaConProductoId>(lineas: T[]): T[] {
  return [...lineas].sort((a, b) =>
    a.productoId < b.productoId ? -1 : a.productoId > b.productoId ? 1 : 0
  )
}
