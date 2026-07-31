// netlify/functions/wompi-confirmation.js
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Mi Paquete API ──────────────────────────────────────────────────────────
// Confirmado desde la colección oficial de Postman ("API mipaquete.com versión 2").
// La colección solo define entornos "local" y "dev":
//   dev: https://api-v2.dev.mpr.mipaquete.com
// No hay una URL de PRODUCCIÓN documentada en la colección — hay que confirmarla
// directamente con Mi Paquete antes de procesar pedidos reales con esta integración.
const MI_PAQUETE_BASE = process.env.MI_PAQUETE_BASE || 'https://api-v2.dev.mpr.mipaquete.com';

// Headers reales confirmados por la documentación (Postman collection):
//   apikey: el JWT de autenticación (SIN prefijo "Bearer")
//   session-tracker: UUID único por petición (se genera en cada llamada, no es fijo)
const MI_PAQUETE_APIKEY = process.env.MI_PAQUETE_API_KEY;

// Datos fijos de la cuenta / bodega de despacho — no cambian por pedido.
const MP_ORIGIN_DANE_CODE = process.env.MI_PAQUETE_ORIGIN_DANE_CODE; // ej. '11001' Bogotá, '05001' Medellín, etc.
const MP_SENDER_NAME = process.env.MI_PAQUETE_SENDER_NAME || 'Flex FK';
const MP_SENDER_SURNAME = process.env.MI_PAQUETE_SENDER_SURNAME || '.';
const MP_SENDER_NIT = process.env.MI_PAQUETE_SENDER_NIT;
const MP_SENDER_NIT_TYPE = process.env.MI_PAQUETE_SENDER_NIT_TYPE || 'NIT';
const MP_SENDER_EMAIL = process.env.MI_PAQUETE_SENDER_EMAIL;
const MP_SENDER_PHONE = process.env.MI_PAQUETE_SENDER_PHONE;
const MP_SENDER_ADDRESS = process.env.MI_PAQUETE_SENDER_ADDRESS; // dirección de recolección
const MP_DELIVERY_COMPANY = process.env.MI_PAQUETE_DELIVERY_COMPANY; // id de transportadora (ver getDeliveryCompanies)
const MP_USER_ID = process.env.MI_PAQUETE_USER_ID; // id de usuario de la cuenta Mi Paquete

function mpHeaders() {
  return {
    apikey: MI_PAQUETE_APIKEY,
    'session-tracker': crypto.randomUUID(),
    'Content-Type': 'application/json'
  };
}

// Genera la guía de envío llamando a POST /createSending
async function crearEnvioMiPaquete(orden) {
  const nameParts = (orden.name || '').trim().split(' ');
  const receiverName = nameParts[0] || orden.name || 'Cliente';
  const receiverSurname = nameParts.slice(1).join(' ') || '.';

  const payload = {
    adminTransactionData: { saleValue: 0 },
    channel: 'FlexFK Web',
    comments: `Pedido ${orden.order_num}`,
    description: `Pedido ${orden.order_num}`,
    criteria: 'price',
    deliveryCompany: MP_DELIVERY_COMPANY,
    locate: {
      destinyDaneCode: orden.destiny_dane_code || '',
      originDaneCode: MP_ORIGIN_DANE_CODE,
      originCountryCode: '484', // Colombia (código ISO numérico), confirmado en la doc
      destinyCountryCode: '484'
    },
    paymentType: 101, // 101 = pago ya realizado (no contraentrega) — confirmado en la doc
    productInformation: {
      declaredValue: orden.total_cop || 0,
      forbiddenProduct: false,
      height: 10,
      large: 20,
      productReference: 'Merch Flex FK',
      quantity: 1,
      weight: 1,
      width: 15
    },
    receiver: {
      cellPhone: (orden.phone || '').replace(/\D/g, '').slice(-10) || '3000000000',
      destinationAddress: orden.address || '',
      email: orden.email || '',
      name: receiverName,
      nit: '.',
      nitType: '.',
      prefix: '+57',
      surname: receiverSurname
    },
    requestPickup: 'false',
    sender: {
      cellPhone: MP_SENDER_PHONE,
      email: MP_SENDER_EMAIL,
      name: MP_SENDER_NAME,
      nit: MP_SENDER_NIT,
      nitType: MP_SENDER_NIT_TYPE,
      pickupAddress: MP_SENDER_ADDRESS,
      prefix: '+57',
      surname: MP_SENDER_SURNAME
    },
    user: MP_USER_ID
  };

  const { data } = await axios.post(`${MI_PAQUETE_BASE}/createSending`, payload, {
    headers: mpHeaders()
  });
  return data;
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
    const referenciaOrden = transaccion.reference; // el orderNum original (FK-XXXXXX)

    if (evento === 'transaction.updated' && estadoWompi === 'APPROVED') {

      const { data: orden, error: dbError } = await supabase
        .from('orders')
        .select('*')
        .eq('order_num', referenciaOrden)
        .single();

      if (dbError) {
        console.error('Error buscando la orden en Supabase:', dbError.message);
      }

      if (orden && orden.payment_status !== 'approved') {
        try {
          const respuestaMiPaquete = await crearEnvioMiPaquete(orden);

          // La forma exacta de la respuesta no está confirmada por completo en la doc,
          // por eso se prueban varias claves posibles.
          const numeroGuia = respuestaMiPaquete.mpCode || respuestaMiPaquete.trackingNumber || respuestaMiPaquete.guideNumber || null;
          const shipmentId = respuestaMiPaquete._id || respuestaMiPaquete.id || null;

          await supabase
            .from('orders')
            .update({
              payment_status: 'approved',
              status: 'processing',
              tracking_number: numeroGuia,
              shipment_id: shipmentId
            })
            .eq('order_num', referenciaOrden);

          console.log(`Automatización exitosa para orden #${referenciaOrden} — guía: ${numeroGuia}`);

        } catch (apiError) {
          console.error('Error en la API de Mi Paquete:', apiError.response ? JSON.stringify(apiError.response.data) : apiError.message);

          // El pago es real pero la generación de guía falló — no se pierde la venta,
          // se marca para despacho manual.
          await supabase
            .from('orders')
            .update({
              payment_status: 'approved',
              status: 'approved_manual_shipping'
            })
            .eq('order_num', referenciaOrden);
        }
      }
    } else if (evento === 'transaction.updated' && (estadoWompi === 'DECLINED' || estadoWompi === 'ERROR' || estadoWompi === 'VOIDED')) {
      await supabase
        .from('orders')
        .update({ payment_status: 'rejected', status: 'cancelled' })
        .eq('order_num', referenciaOrden);
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
