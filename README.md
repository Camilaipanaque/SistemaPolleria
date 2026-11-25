# SistemaPolleria

Aplicación web académica para apoyar la operación diaria de una pollería. Esta rama, `entrega-academica`, reúne avances locales en desarrollo; no representa una nueva versión estable ni cambia el sistema publicado.

**Sistema publicado en Firebase Hosting:** [https://sistemapolleria-87cf1.web.app](https://sistemapolleria-87cf1.web.app)

## Tecnologías

- React 19 y TypeScript.
- Vite 8 para desarrollo y compilación.
- Firebase Authentication para iniciar sesión con correo y contraseña.
- Cloud Firestore para guardar los datos y aplicar reglas de acceso por rol.
- Firebase Hosting para la versión publicada.
- Oxlint y pruebas con Node.js y Firebase Emulator Suite.

## Funcionalidades implementadas en esta rama

- Inicio y cierre de sesión, con comprobación de perfiles activos y roles.
- Gestión de mesas y apertura de atenciones.
- Catálogo de productos con categorías, presentaciones y precios.
- Registro de pedidos con observaciones, cálculo de importes en céntimos y validación transaccional del catálogo y sus precios.
- Panel de cocina con cambios de estado de recibido a preparación y listo; el mozo puede ver los pedidos listos y marcarlos como entregados.
- Caja para registrar pagos en efectivo o Yape, cerrar atenciones e imprimir o guardar tickets en PDF.
- Reportes de ventas con validación de registros e impresión o guardado en PDF.
- Reglas de Firestore para restringir operaciones y datos según el perfil.

## Limitaciones conocidas y trabajo pendiente

- El acceso de usuarios y sus perfiles se aprovisionan fuera de la aplicación. No hay una pantalla administrativa para crear, editar o desactivar usuarios.
- El rol de mozo puede atender los pedidos listos, pero todavía no cuenta con un flujo completo para abrir mesas y registrar pedidos desde su propio panel.
- El rol de cajero está reconocido al iniciar sesión, pero todavía no tiene un panel propio para operar Caja.
- El catálogo y la selección de productos se cargan sin paginación. El README previo recomienda evaluar paginación por cursor cuando el catálogo se acerque a 500 productos o la carga empiece a afectar el rendimiento.
- `auditoria.json` es un reporte guardado, no una auditoría en tiempo real. Ese reporte señala cuatro vulnerabilidades altas en la cadena de dependencias de Firebase/Firestore y `@grpc/grpc-js`. Hay un override de `@grpc/grpc-js` en `package.json`, pero se debe regenerar la auditoría con el lockfile actual para confirmar qué avisos siguen vigentes y planificar su corrección. No se actualizaron dependencias como parte de esta entrega.
- Antes de un uso real, revisar y volver a probar las reglas de Firestore y las dependencias con la auditoría actualizada. La configuración de cliente de Firebase no sustituye las reglas de seguridad del servidor.

## Requisitos

- Node.js compatible con Vite 8 y npm.
- Un proyecto Firebase con Authentication (correo/contraseña), Cloud Firestore y Firebase Hosting.
- Acceso a la configuración web de Firebase. No se requiere guardar claves de cuenta de servicio en la aplicación.

## Instalación y desarrollo

1. Clona el repositorio y cambia a la rama académica:

   ```bash
   git clone https://github.com/Camilaipanaque/SistemaPolleria.git
   cd SistemaPolleria
   git switch entrega-academica
   npm install
   ```

2. Crea un archivo local `.env.local` en la raíz con la configuración web del proyecto Firebase:

   ```dotenv
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   ```

   `.env.local` está excluido de Git. No agregues contraseñas, claves de cuenta de servicio ni datos personales al repositorio.

3. Inicia la aplicación:

   ```bash
   npm run dev
   ```

   Para desarrollo con emuladores locales, inicia Authentication y Firestore Emulator y define `VITE_FIREBASE_USE_EMULATORS=true` en `.env.local`. La aplicación conecta con Auth en `127.0.0.1:9099` y Firestore en `127.0.0.1:8080`.

## Comprobaciones

```bash
npm run lint
npm run build
npm run test:rules
```

`test:rules` levanta el emulador de Firestore para ejecutar las pruebas de reglas y reportes. Requiere que las dependencias y el entorno de emulación estén disponibles.

## Estado de publicación

La rama `entrega-academica` se prepara para revisión académica y no se fusiona con `main`. La URL de Firebase indicada arriba corresponde al sitio publicado existente. Esta entrega no realiza despliegues ni cambios en datos de producción.
