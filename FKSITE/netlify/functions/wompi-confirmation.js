// netlify/functions/wompi-confirmation.js
// Webhook de Wompi. Al recibir un pago APPROVED:
//   1. Cotiza el envío contra todas las transportadoras habilitadas
//   2. Elige automáticamente la más barata (empate -> más rápida)
//   3. Crea la guía real en Mi Paquete
//   4. Guarda todo en Supabase, vinculado siempre por order_num (FK######)
//   5. Envía el correo de confirmación al comprador vía Resend
'use strict';

const mipaquete = require('./lib/mipaquete');
const { getOrderByNum, saveShipmentResult, updateOrder, logShipmentEvent, supabase } = require('./lib/orders');
const { sendOrderStatusEmail } = require('./lib/email');

async function procesarEnvioAutomatico(orden) {
  // orden.items es un JSON string [{id, name, qty, price}] guardado al crear el pedido.
  // Le falta 'cat' (categoría) para calcular el paquete correctamente — se resuelve
  // desde P (catálogo) en el frontend al armar el pedido; si no está disponible acá,
  // calculatePackageForCart cae en el tamaño genérico por defecto.
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

  try {
    const body = JSON.parse(event.body);
    const evento = body.event; // "transaction.updated"
    const transaccion = body.data.transaction;
    const estadoWompi = transaccion.status; // "APPROVED", "DECLINED", etc.
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
      body: JSON.stringify({ received: true })
    };

  } catch (err) {
    console.error('Error procesando Webhook de Wompi:', err);
    return { statusCode: 400, body: 'Error de procesamiento' };
  }
};
