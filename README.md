# BarberApp · servidor

Una sola aplicación: sirve la web (clientes y panel del dueño), guarda las reservas en una base de datos (SQLite) y envía los WhatsApp automáticos con la API oficial de WhatsApp Business, aunque nadie tenga la app abierta.

## 1. WhatsApp Business Platform (Meta)
1. Entrá a developers.facebook.com, creá una app de tipo **Business** y agregá el producto **WhatsApp**.
2. Registrá el número de la barbería. Usá un número dedicado a la API: normalmente un número no puede estar a la vez en la app de WhatsApp común.
3. Anotá el **Phone number ID** (va en `WA_PHONE_NUMBER_ID`).
4. Creá un **token permanente** (Usuario del sistema con permiso `whatsapp_business_messaging`) y ponelo en `WA_TOKEN`.
5. Creá estas **5 plantillas** (categoría *Utilidad*, idioma *Español*). Los nombres y el orden de las variables deben ser exactos:

| Nombre | Texto |
|---|---|
| `barberapp_confirmacion` | ¡Hola, {{1}}! Tu turno en {{2}} quedó confirmado: {{3}}, {{4}} a las {{5}}. |
| `barberapp_recordatorio` | ¡Hola, {{1}}! Te recordamos que hoy tenés un turno en {{2}} a las {{3}} ({{4}}). ¡Te esperamos! |
| `barberapp_cancelacion` | Hola, {{1}}. Tu turno en {{2}} del {{3}} a las {{4}} fue cancelado. |
| `barberapp_cambio` | ¡Hola, {{1}}! Tu turno en {{2}} cambió: {{3}}, {{4}} a las {{5}}. |
| `barberapp_aviso_barbero` | Aviso de agenda: {{1}} · {{2}} ({{3}}) · {{4}} · {{5}} a las {{6}} hs. |

Hasta que Meta las apruebe, los mensajes quedan en cola y se envían solos al aprobarse. Meta cobra por mensaje de plantilla: revisá la tarifa vigente para tu país.

## 2. Alojar (Railway o Render)
1. Subí esta carpeta a un repositorio privado de GitHub.
2. Creá un servicio nuevo desde ese repositorio (Node; comando de inicio `npm start`).
3. Agregá un **volumen / disco persistente** montado en `/data` (ahí vive la base de datos; sin disco se pierden las reservas en cada reinicio).
4. Cargá las variables de `.env.example` en el panel del servicio (`ADMIN_PIN`, `DB_PATH=/data/barberapp.db`, `WA_PHONE_NUMBER_ID`, `WA_TOKEN`).
5. Publicá. El link que te da la plataforma es la app: lo compartís con los clientes. Podés conectar un dominio propio después.

## 3. Primer uso
- Entrá a **Panel** con tu `ADMIN_PIN`. En **Ajustes → Barberos** cargá el WhatsApp de Pabellón y de Joaquín.
- En Ajustes se ve si WhatsApp está conectado y cuántos mensajes hay pendientes.
- Hacé una reserva de prueba con tu propio número antes de abrirla a clientes.

## Notas
- El PIN se cambia con la variable `ADMIN_PIN` (y reiniciando).
- Los números locales (`0981…`) se convierten con `COUNTRY_CODE` (595 por defecto). Zona horaria: `TZ_OFFSET_MIN` (-180 = Paraguay).
- Hacé copias del disco o de `barberapp.db` periódicamente.
- Cada cliente puede tener hasta 3 turnos activos y hay límite de intentos por IP para evitar abusos.
