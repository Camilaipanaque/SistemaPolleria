
import { useState } from 'react'
import GestionMesas from './GestionMesas'
import GestionPedidos from './GestionPedidos'
import GestionProductos from './GestionProductos'
import GestionPagos from './GestionPagos'
import ReportesVentas from './ReportesVentas'
import PanelCocina from './PanelCocina'
import './PanelAdmin.css'

type PanelAdminProps = {
  usuarioId: string
  nombreUsuario: string
  onCerrarSesion: () => void
}

function PanelAdmin({ usuarioId, nombreUsuario, onCerrarSesion }: PanelAdminProps) {
  const [seccion, setSeccion] = useState('inicio')

  if (seccion === 'mesas') {
    return (
      <div className="panel-admin">
        <header className="panel-header">
          <h1>🍗 SistemaPolleria</h1>
          <p>Gestión de Mesas</p>
        </header>

        <main className="panel-contenido">
          <button
            type="button"
            className="panel-cerrar"
            onClick={() => setSeccion('inicio')}
          >
            ⬅ Volver al panel
          </button>

          <GestionMesas usuarioId={usuarioId} nombreUsuario={nombreUsuario} />
        </main>
      </div>
    )
  }

  if (seccion === 'productos') {
    return (
      <div className="panel-admin">
        <header className="panel-header">
          <h1>🍗 SistemaPolleria</h1>
          <p>Gestión de Productos</p>
        </header>

        <main className="panel-contenido">
          <button
            type="button"
            className="panel-cerrar"
            onClick={() => setSeccion('inicio')}
          >
            ⬅ Volver al panel
          </button>

          <GestionProductos usuarioId={usuarioId} />
        </main>
      </div>
    )
  }

  if (seccion === 'pedidos') {
    return (
      <div className="panel-admin">
        <header className="panel-header">
          <h1>🍗 SistemaPolleria</h1>
          <p>Gestión de Pedidos</p>
        </header>

        <main className="panel-contenido">
          <button
            type="button"
            className="panel-cerrar"
            onClick={() => setSeccion('inicio')}
          >
            ⬅ Volver al panel
          </button>

          <GestionPedidos usuarioId={usuarioId} />
        </main>
      </div>
    )
  }

  if (seccion === 'caja') {
    return (
      <div className="panel-admin">
        <header className="panel-header">
          <h1>🍗 SistemaPolleria</h1>
          <p>Caja y pagos</p>
        </header>
        <main className="panel-contenido">
          <button type="button" className="panel-cerrar" onClick={() => setSeccion('inicio')}>
            ⬅ Volver al panel
          </button>
          <GestionPagos usuarioId={usuarioId} />
        </main>
      </div>
    )
  }

  if (seccion === 'reportes') {
    return (
      <div className="panel-admin">
        <header className="panel-header">
          <h1>🍗 SistemaPolleria</h1>
          <p>Reportes de ventas</p>
        </header>
        <main className="panel-contenido">
          <button type="button" className="panel-cerrar" onClick={() => setSeccion('inicio')}>
            ⬅ Volver al panel
          </button>
          <ReportesVentas usuarioId={usuarioId} />
        </main>
      </div>
    )
  }

  if (seccion === 'cocina') {
    return <PanelCocina
      usuarioId={usuarioId}
      nombreUsuario={nombreUsuario}
      puedeEntregar
      onVolver={() => setSeccion('inicio')}
    />
  }

  return (
    <div className="panel-admin">
      <header className="panel-header">
        <h1>🍗 SistemaPolleria</h1>
        <p>Panel de Administración</p>
      </header>

      <main className="panel-contenido">
        <h2>¡Bienvenido, {nombreUsuario}!</h2>
        <p>Gestiona tu pollería desde aquí.</p>

        <section>
          <h3>Menú principal</h3>

          <div className="panel-menu">
            <button
              type="button"
              onClick={() => setSeccion('mesas')}
            >
              🪑 Mesas
            </button>

            <button type="button" onClick={() => setSeccion('productos')}>
              🍗 Productos
            </button>
            <button type="button" onClick={() => setSeccion('pedidos')}>
              📝 Pedidos
            </button>
            <button type="button" onClick={() => setSeccion('cocina')}>
              🍳 Cocina
            </button>
            <button type="button" onClick={() => setSeccion('caja')}>💰 Caja</button>
            <button type="button" onClick={() => setSeccion('reportes')}>📊 Reportes</button>
          </div>
        </section>

        <button
          type="button"
          className="panel-cerrar"
          onClick={onCerrarSesion}
        >
          🚪 Cerrar sesión
        </button>
      </main>
    </div>
  )
}

export default PanelAdmin
