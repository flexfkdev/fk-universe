// netlify/functions/order-lookup.js
// Búsqueda de pedidos para el widget público de "Rastrear pedido". Corre del
// lado del servidor con la service_role key (ignora RLS) para poder buscar por
// order_num o por email, sin que el frontend necesite acceso directo de lectura
// amplio a la tabla 'orders' (que ahora está bloqueada por RLS salvo admin).
//
// Devuelve SOLO los campos que la UI de tracking realmente usa — nunca email,
// teléfono, ni nombre completo del cliente — para minimizar qué se expone
// incluso si alguien intercepta la respuesta o adivina un email ajeno.
'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SAFE_FIELDS = 'order_num,payment_status,shipping_status,created_at,shipment_created_at,shipment_delivered_at,tracking_number,delivery_company_name,address';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  const q = (event.queryStringParameters && event.queryStringParameters.q || '').trim();
  if (!q) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Falta el parámetro de búsqueda' })
    };
  }

  try {
    let query = supabase.from('orders').select(SAFE_FIELDS);

    if (q.toUpperCase().startsWith('FK-')) {
      query = query.eq('order_num', q.toUpperCase());
    } else {
      // Búsqueda por email — solo devuelve los campos seguros de arriba, nunca
      // el email/teléfono/nombre de la orden encontrada.
      query = query.eq('email', q).order('created_at', { ascending: false }).limit(5);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error buscando pedido:', error.message);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Error al buscar el pedido' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: data || [] })
    };

  } catch (err) {
    console.error('Error en order-lookup:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Error al buscar el pedido' })
    };
  }
};
