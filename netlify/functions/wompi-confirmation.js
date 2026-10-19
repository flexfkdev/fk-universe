// netlify/functions/wompi-confirmation.js
// Webhook de Wompi. Al recibir un evento transaction.updated con estado APPROVED:
//   0. VALIDA el checksum del evento (obligatorio — evita eventos falsificados)
//   1. Verifica que el monto pagado coincida con el total de la orden
//   2. Crea la guía en Mi Paquete con la transportadora ya cotizada en el checkout
//      (el cliente pagó ese envío dentro del total de Wompi)
//   3. Guarda todo en Supabase, vinculado siempre por order_num (FK######)
//   4. Envía el correo de confirmación al comprador vía Resend
//
// Formato real del evento y validación de firma confirmados en:
// https://docs.wompi.co/docs/colombia/eventos/
'use strict';

const crypto = require('crypto');
const { getOrderByNum, updateOrder, logShipmentEvent } = require('./lib/orders');
const { processShipment, recordShipmentFailure } = require('./lib/shipping');
const { sendOrderStatusEmail } = require('./lib/email');

const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET;

/**
 * Valida el checksum de un evento de Wompi según el algoritmo oficial:
 *   SHA256( <valores de signature.properties en orden> + <timestamp> + <secreto de eventos> )
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

  const values = signature.properties.map(path => {
    const parts = path.split('.');
    let val = body.data;
    for (const p of parts) { val = val && val[p]; }
    return val != null ? String(val) : '';
  });

  const cadena = values.join('') + String(body.timestamp) + WOMPI_EVENTS_SECRET;
  const checksumCalculado = crypto.createHash('sha256').update(cadena).digest('hex').toUpperCase();
  const checksumRecibido = String(signature.checksum).toUpperCase();
  const coincide = checksumCalculado === checksumRecibido;

  if (!coincide) {
    console.error('Checksum no coincide.', {
      properties: signature.properties, valoresExtraidos: values, timestamp: body.timestamp,
      checksumCalculado, checksumRecibido
    });
  }
  return coincide;
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

  // 0. VALIDACIÓN DE AUTENTICIDAD. Por defecto, si el checksum no coincide, SOLO se registra
  // en los logs. Cuando confirmes en los logs que coincide en un evento real, pon
  // WOMPI_STRICT_CHECKSUM=true en Netlify para rechazar cualquier evento que no calce.
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
        // 1. El monto cobrado debe coincidir con el total de la orden (que incluye el envío)
        const pagado = Number(transaccion.amount_in_cents);
        const esperado = Math.round(Number(orden.total_cop) * 100);
        if (pagado && pagado !== esperado) {
          console.error(`Monto no coincide para ${referenciaOrden}: pagado=${pagado} esperado=${esperado}`);
          await updateOrder(referenciaOrden, { payment_status: 'approved', status: 'review', shipping_status: 'failed' });
          await logShipmentEvent(referenciaOrden, 'amount_mismatch', 'review', { pagado, esperado });
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ received: true, verified: true, review: true })
          };
        }

        await updateOrder(referenciaOrden, { payment_status: 'approved', status: 'processing' });

        // 2-3. Crear la guía con la transportadora y precio ya cotizados en el checkout
        let shipResult = { success: false };
        try {
          shipResult = await processShipment(orden);
        } catch (shipError) {
          const r = await recordShipmentFailure(referenciaOrden, shipError);
          // Sin saldo en Mi Paquete: se avisa al admin, no se arregla reintentando solo.
          // Recarga el saldo y usa "Reintentar guía" en el panel de pedidos.
          if (r.isBalanceError && process.env.MI_PAQUETE_SENDER_EMAIL) {
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

        // 4. Correo de confirmación (con o sin guía — igual se le avisa al cliente)
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
