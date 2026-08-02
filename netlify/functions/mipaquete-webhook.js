// netlify/functions/mipaquete-webhook.js
// Recibe las actualizaciones de estado que Mi Paquete envía a la URL registrada
// como "urlForStates" (ver createWebHook). Formato real confirmado en su doc:
//   { "state": "Distribución", "tracking": [{updateState, date}, ...], "code": 895895 }
// El "code" identifica la GUÍA, no el pedido — por eso se usa únicamente como clave
// de búsqueda para encontrar la orden; a partir de ahí todo se maneja por order_num.
'use strict';

const { supabase, updateOrder, logShipmentEvent } = require('./lib/orders');
const { sendOrderStatusEmail } = require('./lib/email');

// Traduce los estados de texto libre de Mi Paquete a las claves internas que
// usa nuestra plantilla de email / UI. Se hace con includes() porque el texto
// exacto puede variar ligeramente ("Distribución", "En distribución", etc.).
function mapMiPaqueteStateToInternal(stateText) {
  const s = (stateText || '').toLowerCase();
  if (s.includes('entreg')) return 'delivered';
  if (s.includes('distribuci') || s.includes('camino') || s.includes('transito') || s.includes('tránsito')) return 'in_transit';
  if (s.includes('cancel') || s.includes('rechaz') || s.includes('devuel')) return 'cancelled';
  if (s.includes('program') || s.includes('procesando') || s.includes('pendiente')) return 'created';
  return 'created';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  try {
    const body = JSON.parse(event.body);
    const mpCode = body.code; // identificador de la guía según Mi Paquete
    const stateText = body.state || '';

    if (!mpCode) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Falta el campo code en el payload' }) };
    }

    // Buscar el pedido por tracking_number — SOLO como clave de búsqueda puntual,
    // el identificador que se usa en el resto del sistema sigue siendo order_num.
    const { data: orden, error } = await supabase
      .from('orders')
      .select('*')
      .eq('tracking_number', String(mpCode))
      .single();

    if (error || !orden) {
      console.warn(`Webhook de Mi Paquete recibido para code=${mpCode} pero no se encontró ningún pedido con ese tracking_number.`);
      // Igual respondemos 200 para que Mi Paquete no reintente indefinidamente
      // un code que nunca vamos a poder emparejar.
      return { statusCode: 200, body: JSON.stringify({ received: true, matched: false }) };
    }

    const internalStatus = mapMiPaqueteStateToInternal(stateText);
    const isDelivered = internalStatus === 'delivered';

    const updates = {
      shipping_status: internalStatus
    };
    if (isDelivered) {
      updates.shipment_delivered_at = new Date().toISOString();
    }

    await updateOrder(orden.order_num, updates);
    await logShipmentEvent(orden.order_num, 'status_update', internalStatus, body);

    // Enviar correo automático de actualización de estado al comprador
    const emailResult = await sendOrderStatusEmail({
      to: orden.email,
      orderNum: orden.order_num,
      name: orden.name,
      statusKey: internalStatus,
      carrierName: orden.delivery_company_name,
      trackingNumber: orden.tracking_number
    });

    await updateOrder(orden.order_num, {
      last_email_sent_at: new Date().toISOString(),
      last_email_status: emailResult.ok ? 'sent' : 'failed'
    });
    await logShipmentEvent(orden.order_num, 'email_sent', emailResult.ok ? 'sent' : 'failed', emailResult);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true, matched: true, order_num: orden.order_num, status: internalStatus })
    };

  } catch (err) {
    console.error('Error procesando webhook de Mi Paquete:', err);
    return { statusCode: 400, body: 'Error de procesamiento' };
  }
};
