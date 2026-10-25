# PaqueteYa

App web para paqueterías / puntos de entrega: registro de paquetes, QR por paquete, etiqueta térmica imprimible y escáner.

## Ejecutar en local

```bash
npm install
npm run dev          # http://localhost:3000 (con recarga automática)
npm start
```

Requiere Node 22+. Lee las variables de `.env` (no se sube a git). La base de datos es Postgres en Supabase.

## Base de datos (Supabase)

- `sql/schema.sql`: tablas. Aplicar con `npm run db:schema` (se puede repetir sin romper nada).
- `npm run db:migrar`: copia los datos de la antigua base SQLite (`data/app.db`) a Postgres. Sólo si se quieren conservar esos datos.
- RLS está activado sin políticas: la API REST pública de Supabase no puede leer las tablas; el servidor sí, porque se conecta como `postgres`.

## Variables de entorno

| Variable         | Uso                                                                                         |
|------------------|---------------------------------------------------------------------------------------------|
| `DATABASE_URL`   | URI del *Transaction pooler* de Supabase (puerto 6543). Caracteres especiales de la contraseña codificados (`@` → `%40`). |
| `SESSION_SECRET` | Clave para firmar la cookie de sesión. Obligatoria en Vercel.                               |
| `BASE_URL`       | Opcional. URL pública que se graba en los QR. Sin ella, en Vercel se usa el dominio de producción del proyecto (`xxx.vercel.app`). |
| `PORT`           | Sólo local (por defecto 3000).                                                              |

## Desplegar en Vercel

1. Subir el repositorio a GitHub e importarlo en Vercel (detecta Express sin configuración).
2. En *Settings → Environment Variables* agregar `DATABASE_URL` y `SESSION_SECRET` (Production y Preview).
3. `vercel.json` fija la región `cle1` (Cleveland), junto a la base en `us-east-2`.
4. Los archivos de `public/` los sirve la CDN de Vercel; `views/` se incluye solo en la función.

> La cámara del navegador sólo funciona en `https://` o en `localhost`. Si más adelante hay dominio propio, definir `BASE_URL` **antes** de imprimir etiquetas: la URL queda grabada en cada QR.

## Rutas

- `/` landing · `/registro` · `/login`
- `/app` paquetes (Por recibir / En el punto / Entregados + búsqueda)
- `/app/registrar` nuevo paquete → código `P{punto}-00001` + QR
- `/app/escanear` QR con cámara o foto de la galería
- `/app/paquete/:codigo` ficha, cambio de estado, avisos por WhatsApp
- `/app/paquete/:codigo/ticket` etiqueta para impresora térmica 58/80 mm
- `/q/:token` destino del QR: exige sesión y que el paquete sea de ese punto
