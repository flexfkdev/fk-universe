// netlify/functions/lib/orders.js
// Módulo reutilizable de acceso a la tabla 'orders' y su historial 'shipment_events'.
// El identificador principal de todo el sistema es SIEMPRE order_num (FK######),
// nunca el tracking_number de la transportadora.
'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/** Busca un pedido por su order_num (FK######). Devuelve null si no existe. */
async function getOrderByNum(orderNum) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('order_num', orderNum)
    .single();
  if (error) {
    if (error.code !== 'PGRST116') console.error('getOrderByNum error:', error.message);
    return null;
  }
  return data;
}

/** Actualiza campos arbitrarios de un pedido, identificado por order_num. */
async function updateOrder(orderNum, fields) {
  const { error } = await supabase
    .from('orders')
    .update(fields)
    .eq('order_num', orderNum);
  if (error) {
    console.error('updateOrder error:', error.message);
    throw error;
  }
}

/** Registra un evento en el historial de envío (auditoría). No lanza si falla. */
async function logShipmentEvent(orderNum, eventType, status, rawPayload) {
  try {
    await supabase.from('shipment_events').insert([{
      order_num: orderNum,
      event_type: eventType,
      status: status || null,
      raw_payload: rawPayload || null
    }]);
  } catch (e) {
    console.warn('No se pudo registrar shipment_event:', e.message);
  }
}

/** Guarda el resultado de la cotización + creación de envío en la orden. */
async function saveShipmentResult(orderNum, { carrierId, carrierName, price, trackingNumber, shipmentId, status }) {
  await updateOrder(orderNum, {
    delivery_company_id: carrierId || null,
    delivery_company_name: carrierName || null,
    shipping_price: price != null ? price : null,
    tracking_number: trackingNumber || null,
    shipment_id: shipmentId || null,
    shipping_status: status || 'created',
    shipment_created_at: new Date().toISOString()
  });
}

module.exports = { supabase, getOrderByNum, updateOrder, logShipmentEvent, saveShipmentResult };
