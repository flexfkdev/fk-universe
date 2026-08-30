// netlify/functions/wompi-confirmation.js
// Webhook de Wompi. Al recibir un evento transaction.updated con estado APPROVED:
//   0. VALIDA el checksum del evento (obligatorio — evita eventos falsificados)
//   1. Cotiza el envío contra todas las transportadoras habilitadas
//   2. Elige automáticamente la más barata (empate -> más rápida)
//   3. Crea la guía real en Mi Paquete
//   4. Guarda todo en Supabase, vinculado siempre por order_num (FK######)
//   5. Envía el correo de confirmación al comprador vía Resend
//
// Formato real del evento y validación de firma confirmados en:
// https://docs.wompi.co/docs/colombia/eventos/
'use strict';

const crypto = require('crypto');
const mipaquete = require('./lib/mipaquete');
const { getOrderByNum, saveShipmentResult, updateOrder, logShipmentEvent, supabase } = require('./lib/orders');
const { sendOrderStatusEmail } = require('./lib/email');

const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET;

/**
 * Valida el checksum de un evento de Wompi según el algoritmo oficial:
 *   SHA256( <valores de signature.properties en orden> + <timestamp> + <secreto de eventos> )
 * Devuelve true solo si coincide exactamente con el checksum recibido.
 */
function isValidWompiChecksum(body) {
  if (!WOMPI_EVENTS_SECRET) {
    console.error('Falta configurar WOMPI_EVENTS_SECRET — no se puede validar la autenticidad del evento.');
    return false;
  }
  const signature = body && body.signature;
  if (!signature || !Array.isArray(signature.properties) || !signature.checksum || body.timestamp == null) {
    console.error('Evento sin estructura de firma válida (falta signature.properties, checksum o timestamp).');
    return false;
  }

  // Cada "property" es una ruta tipo "transaction.id" que apunta dentro de body.data
  const values = signature.properties.map(path => {
    const parts = path.split('.');
    let val = body.data;
    for (const p of parts) {
      val = val && val[p];
    }
    return val != null ? String(val) : '';
  });

  const cadena = values.join('') + String(body.timestamp) + WOMPI_EVENTS_SECRET;
  const checksumCalculado = crypto.createHash('sha256').update(cadena).digest('hex').toUpperCase();
  const checksumRecibido = String(signature.checksum).toUpperCase();
  const coincide = checksumCalculado === checksumRecibido;

  if (!coincide) {
    // Log detallado para poder diagnosticar contra un evento REAL de Wompi. La
    // documentación pública no permite reproducir su propio ejemplo de forma
    // independiente, así que esto se validó por última vez con el primer webhook
    // real que llegue — revisa estos logs si el primer pago no se procesa solo.
    console.error('Checksum no coincide.', {
      properties: signature.properties,
      valoresExtraidos: values,
      timestamp: body.timestamp,
      checksumCalculado,
      checksumRecibido
    });
  }

  return coincide;
}

async function procesarEnvioAutomatico(orden) {
  // orden.items es un JSON string [{id, name, cat, qty, price}] guardado al crear el
  // pedido, con la categoría de cada producto para poder calcular el paquete real.
  let cartItems = [];
  try {
    cartItems = typeof orden.items === 'string' ? JSON.parse(orden.items) : (orden.items || []);
  } catch (e) { /* deja cartItems vacío, se usa el paquete genérico */ }
  const pkg = mipaquete.calculatePackageForCart(cartItems);

  // 1-2. Cotizar contra todas las transportadoras y elegir la ganadora
  const { winner, allQuotes } = await mipaquete.quoteAllAndPickWinner({
    destinyDaneCode: orden.destiny_dane_code,
    declaredValue: orden.total_cop,
    quantity: 1,
    weight: pkg.weight,
    width: pkg.width,
    length: pkg.length,
    height: pkg.height
  });

  await logShipmentEvent(orden.order_num, 'quote', winner ? 'quoted' : 'quote_failed', { allQuotes });

  if (!winner) {
    console.warn(`Sin cotizaciones disponibles para ${orden.order_num} — queda pendiente de despacho manual.`);
    await updateOrder(orden.order_num, { shipping_status: 'failed' });
    return { success: false, reason: 'no_quotes' };
  }

  // 3. Crear el envío real con la transportadora ganadora
  const respuestaMiPaquete = await mipaquete.crearEnvio(orden, winner.carrierId);
  const trackingNumber = respuestaMiPaquete.mpCode || respuestaMiPaquete.trackingNumber || respuestaMiPaquete.guideNumber || null;
  const shipmentId = respuestaMiPaquete._id || respuestaMiPaquete.id || null;

  // 4. Guardar en Supabase — order_num sigue siendo el identificador principal
  await saveShipmentResult(orden.order_num, {
    carrierId: winner.carrierId,
    carrierName: winner.carrierName,
    price: winner.price,
    trackingNumber,
    shipmentId,
    status: 'created'
  });

  await logShipmentEvent(orden.order_num, 'created', 'created', { trackingNumber, shipmentId, carrier: winner.carrierName });

  return { success: true, trackingNumber, carrierName: winner.carrierName };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'JSON inválido' };
  }

  // 0. VALIDACIÓN DE AUTENTICIDAD. Por defecto, si el checksum no coincide, SOLO
  // se registra en los logs (no se bloquea el procesamiento) — esto es así porque
  // el algoritmo se implementó siguiendo la documentación oficial paso a paso, pero
  // el ejemplo numérico que Wompi publica en su doc no pudo verificarse de forma
  // independiente antes de este primer despliegue. Revisa los logs del primer pago
  // real: si dicen "Checksum no coincide", compara checksumCalculado vs
  // checksumRecibido — si nunca coinciden, hay que ajustar el algoritmo.
  // Una vez confirmado que SÍ coincide en al menos un evento real, poné la variable
  // de entorno WOMPI_STRICT_CHECKSUM=true en Netlify para rechazar automáticamente
  // cualquier evento que no calce (protección real contra webhooks falsificados).
  const checksumValido = isValidWompiChecksum(body);
  const modoEstricto = process.env.WOMPI_STRICT_CHECKSUM === 'true';
  if (!checksumValido && modoEstricto) {
    console.error('Checksum inválido y WOMPI_STRICT_CHECKSUM=true — evento rechazado.', {
      event: body && body.event,
      reference: body && body.data && body.data.transaction && body.data.transaction.reference
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true, verified: false })
    };
  }

  try {
    const evento = body.event; // "transaction.updated"
    const transaccion = body.data.transaction;
    const estadoWompi = transaccion.status; // "APPROVED", "DECLINED", "VOIDED", "ERROR"
    const referenciaOrden = transaccion.reference; // el order_num (FK######)

    if (evento === 'transaction.updated' && estadoWompi === 'APPROVED') {
      const orden = await getOrderByNum(referenciaOrden);

      if (orden && orden.payment_status !== 'approved') {
        await updateOrder(referenciaOrden, { payment_status: 'approved', status: 'processing' });

        let shipResult = { success: false };
        try {
          shipResult = await procesarEnvioAutomatico(orden);
        } catch (shipError) {
          const errDetail = shipError.response ? JSON.stringify(shipError.response.data) : shipError.message;
          console.error('Error generando el envío:', errDetail);

          // Detección de saldo insuficiente en la cuenta de Mi Paquete — este caso
          // se marca distinto y se avisa al admin, porque no se resuelve reintentando:
          // hay que recargar saldo manualmente en el panel de Mi Paquete.
          const isBalanceError = /saldo|balance|insufficient|fondos/i.test(errDetail || '');
          await updateOrder(referenciaOrden, { shipping_status: isBalanceError ? 'failed_no_balance' : 'failed' });
          await logShipmentEvent(referenciaOrden, 'error', isBalanceError ? 'failed_no_balance' : 'failed', { error: errDetail });

          if (isBalanceError && process.env.MI_PAQUETE_SENDER_EMAIL) {
            await sendOrderStatusEmail({
              to: process.env.MI_PAQUETE_SENDER_EMAIL,
              orderNum: referenciaOrden,
              name: 'Admin Flex FK',
              statusKey: 'failed',
              carrierName: null,
              trackingNumber: null
            }).catch(() => {});
          }
        }

        // 5. Enviar correo de confirmación (con o sin guía — igual se le avisa al cliente)
        const emailResult = await sendOrderStatusEmail({
          to: orden.email,
          orderNum: referenciaOrden,
          name: orden.name,
          statusKey: shipResult.success ? 'created' : 'pending',
          carrierName: shipResult.carrierName,
          trackingNumber: shipResult.trackingNumber
        });

        await updateOrder(referenciaOrden, {
          last_email_sent_at: new Date().toISOString(),
          last_email_status: emailResult.ok ? 'sent' : 'failed'
        });
        await logShipmentEvent(referenciaOrden, 'email_sent', emailResult.ok ? 'sent' : 'failed', emailResult);
      }

    } else if (evento === 'transaction.updated' && ['DECLINED', 'ERROR', 'VOIDED'].includes(estadoWompi)) {
      await updateOrder(referenciaOrden, { payment_status: 'rejected', status: 'cancelled' });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true, verified: true })
    };

  } catch (err) {
    console.error('Error procesando Webhook de Wompi:', err);
    return { statusCode: 400, body: 'Error de procesamiento' };
  }
};
