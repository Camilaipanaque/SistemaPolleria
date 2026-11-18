
import { useState, type FormEvent } from 'react'
import { signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from './firebase'
import './App.css'
import PanelAdmin from './components/PanelAdmin'

type Perfil = {
  uid: string
  nombre: string
  rol: string
  activo: boolean
}

function App() {
  const [correo, setCorreo] = useState('')
  const [contrasena, setContrasena] = useState('')
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [mensaje, setMensaje] = useState('')
  const [cargando, setCargando] = useState(false)

  async function iniciarSesion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setMensaje('')
    setCargando(true)

    try {
      const credencial = await signInWithEmailAndPassword(
        auth,
        correo.trim(),
        contrasena
      )

      const referencia = doc(db, 'usuarios', credencial.user.uid)
      const documento = await getDoc(referencia)

      if (!documento.exists()) {
        await signOut(auth)
        setMensaje('No tienes un perfil registrado en el sistema.')
        return
      }

      const datos = documento.data()

      if (
        typeof datos.nombre !== 'string' ||
        typeof datos.rol !== 'string' ||
        datos.activo !== true ||
        !['administrador', 'mozo', 'cocina', 'cajero'].includes(datos.rol)
      ) {
        await signOut(auth)
        setMensaje('Tu perfil no está activo o no es válido.')
        return
      }

      setPerfil({
        uid: credencial.user.uid,
        nombre: datos.nombre,
        rol: datos.rol,
        activo: datos.activo,
      })

      setContrasena('')
    } catch (error) {
      console.error('Error al iniciar sesión:', error)
      await signOut(auth).catch(() => {})
      setMensaje(
        'No se pudo iniciar sesión. Verifica tus datos y la conexión con Firebase.'
      )
    } finally {
      setCargando(false)
    }
  }

  async function cerrarSesion() {
    await signOut(auth)
    setPerfil(null)
    setCorreo('')
    setContrasena('')
    setMensaje('')
  }

  if (perfil) {
    if (perfil.rol === 'administrador') {
      return <PanelAdmin usuarioId={perfil.uid} nombreUsuario={perfil.nombre} onCerrarSesion={cerrarSesion} />
    }

    return (
      <main>
        <div className="login-card">
          <h1>Sistema de Gestión de Pollería</h1>
          <h2>¡Bienvenido, {perfil.nombre}!</h2>
          <p>Rol: {perfil.rol}</p>

          <button onClick={cerrarSesion}>
            Cerrar sesión
          </button>
        </div>
      </main>
    )
  }


  return (
    <main>
      <div className="login-card">
        <h1>Sistema de Gestión de Pollería</h1>
        <h2>Bienvenido</h2>
        <p>Ingresa tus datos para continuar</p>

        <form onSubmit={iniciarSesion}>
          <label htmlFor="correo">Correo electrónico</label>
          <input
            id="correo"
            type="email"
            placeholder="ejemplo@correo.com"
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            required
          />

          <label htmlFor="contrasena">Contraseña</label>
          <input
            id="contrasena"
            type="password"
            placeholder="Ingresa tu contraseña"
            value={contrasena}
            onChange={(e) => setContrasena(e.target.value)}
            required
          />

          {mensaje && <p role="alert">{mensaje}</p>}

          <button type="submit" disabled={cargando}>
            {cargando ? 'Ingresando...' : 'Iniciar sesión'}
          </button>
        </form>
      </div>
    </main>
  )
}

export default App

