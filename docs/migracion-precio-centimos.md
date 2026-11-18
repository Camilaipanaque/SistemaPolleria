# Migración controlada de precios a céntimos

Los productos antiguos que solo tienen `precio` siguen siendo legibles y pueden usarse en pedidos. El cliente y las reglas derivan los céntimos redondeando el precio legado; la lectura no escribe ni actualiza documentos. Los productos nuevos o editados guardan ambos campos. Actualmente la regla limita los pedidos a cuatro líneas porque el emulador excedió el máximo de 1.000 expresiones al validar cinco productos:

```json
{
  "precio": 12.5,
  "precioCentimos": 1250
}
```

Las reglas exigen que ambos valores coincidan para las escrituras nuevas. `precioCentimos` es la fuente autoritativa para calcular pedidos.

## Procedimiento manual recomendado

1. Antes de migrar, exporta únicamente la colección `productos` y conserva una copia sin editar.
2. Genera una vista previa de cada documento: ID, `precio` original, céntimos calculados y cualquier valor inválido. No incluyas colecciones `mesas`, `atenciones` ni `pedidos`.
3. Revisa manualmente los casos cuyo `precio` no sea un número finito no negativo o supere `100000000.00`. Corrige el catálogo por el proceso operativo habitual antes de continuar.
4. En una ventana de mantenimiento, escribe `precioCentimos` como entero y normaliza `precio` a `precioCentimos / 100`. Actualiza solo documentos revisados, sin reemplazar campos ajenos al precio.
5. Verifica una muestra del catálogo y ejecuta `npm run test:rules` contra el emulador antes de considerar la migración terminada.

Este repositorio no contiene una rutina que se conecte a producción ni ejecute esta migración. La migración es manual, revisable y no se activa al iniciar la aplicación.
