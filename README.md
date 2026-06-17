# Calidad B2B fuera de Google Apps Script

Proyecto local para migrar la plataforma desde Google Apps Script hacia Node.js.

## Estructura

- `public/index.html`: copia funcional del ultimo `Index-corregido.html`, adaptada para correr local.
- `public/gas-bridge.js`: puente compatible con `google.script.run`, pero enviando llamadas al backend Node.
- `server/`: API local que reemplaza funciones principales de `Code.gs`.
- `reference/`: copias sin tocar del ultimo `Index-corregido.html` y `Code-corregido.gs`.
- `.env`: configuracion local de Firebase, Google Sheet y Drive.

## Ejecutar

```bash
cd "C:\Users\Pablo Enrique\Documents\Codex\2026-06-01\files-mentioned-by-the-user-texto\calidad-b2b-vscode"
npm install
npm run dev
```

Abrir:

```text
http://localhost:5174
```

## Estado actual

- Firebase ya funciona desde Node.
- Usuarios cargan desde Firebase.
- Evaluaciones cargan rapido desde `evaluations_v1`.
- Detalle individual carga desde `evaluation_record_<id>`.
- El frontend ya no usa el secreto de Firebase directamente; lo consulta por el backend local.
- Google Sheets queda como referencia de lectura pendiente de migrar a Node.
- Drive tiene implementada la lectura/escritura real, pero necesita `GOOGLE_APPLICATION_CREDENTIALS` para conectarse desde Node.

## Pruebas realizadas

- `GET /api/health`: OK.
- `POST /api/gas/listEvaluationRecords`: 240 evaluaciones en aproximadamente 1.2s.
- `POST /api/gas/getEvaluationRecordDetail` con una evaluacion real: 13 secciones y 1 archivo en aproximadamente 0.6s.

## Configurar Drive

Para que Node pueda leer carpetas y subir audios/imagenes a Drive:

1. Crear o usar una cuenta de servicio en Google Cloud.
2. Descargar el JSON de credenciales.
3. Compartir la carpeta Drive con el email de la cuenta de servicio como editor:

```text
1H1yNrsLizMKyDQanoiLCsAymV7BAaSm9
```

4. Configurar `.env`:

```text
GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\a\service-account.json
```

5. Reiniciar:

```bash
npm run dev
```

Validar:

```text
http://localhost:5174/api/drive/validate
```

## Siguiente paso recomendado

Configurar las credenciales de Drive y probar una evaluacion nueva con audio. La carpeta objetivo se mantiene:

```text
1H1yNrsLizMKyDQanoiLCsAymV7BAaSm9
```
