// netlify/functions/wompi-checkout.js
// Crea el pedido y la firma de integridad de Wompi.
// IMPORTANTE: el total NO se toma del navegador. Se recalcula aquí con los precios reales de la
// tabla 'products' (+ descuento del producto, + código de descuento válido, + envío cotizado),
// así nadie puede pagar menos manipulando el JavaScript de la página.
'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const mipaquete = require('./lib/mipaquete');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

// Misma lógica que el frontend: "$90.000" -> 90000, "90000" -> 90000, "1.250,50" -> 1250.5
function parsePrice(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9.,]/g, '');
  if (!s) return 0;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return parseFloat(s.replace(/,/g, ''));
  return parseFloat(s.replace(',', '.')) || 0;
}

async function buildItems(clientItems) {
  const list = (Array.isArray(clientItems) ? clientItems : []).slice(0, 40).map(p => ({
    id: String(p && p.id), qty: Math.max(1, Math.min(20, parseInt(p && p.qty, 10) || 1))
  }));
  if (!list.length) throw new Error('El carrito está vacío');

  const prodIds = [...new Set(list.filter(i => !i.id.startsWith('ticket_')).map(i => i.id))];
  const tktIds = [...new Set(list.filter(i => i.id.startsWith('ticket_')).map(i => i.id.slice(7)))];

  const products = {};
  if (prodIds.length) {
    const { data, error } = await supabase.from('products')
      .select('id,name,price,cat,discount,ship_weight,ship_width,ship_length,ship_height').in('id', prodIds);
    if (error) throw new Error('No se pudieron leer los productos');
    (data || []).forEach(r => { products[String(r.id)] = r; });
  }
  const tickets = {};
  if (tktIds.length) {
    const { data } = await supabase.from('ticket_types').select('id,name,price').in('id', tktIds);
    (data || []).forEach(r => { tickets['ticket_' + r.id] = r; });
  }

  return list.map(i => {
    const r = products[i.id] || tickets[i.id];
    if (!r) throw new Error('Un producto de tu carrito ya no está disponible');
    let unit = parsePrice(r.price);
    if (r.discount) unit = unit * (1 - (parseFloat(r.discount) || 0) / 100);
    unit = Math.round(unit);
    const isTicket = i.id.startsWith('ticket_');
    return {
      id: i.id, name: r.name, cat: isTicket ? 'Tickets' : r.cat, qty: i.qty,
      price: r.price, unitPrice: unit, subtotal: unit * i.qty,
      shipWeight: r.ship_weight != null ? r.ship_weight : null,
      shipWidth: r.ship_width != null ? r.ship_width : null,
      shipLength: r.ship_length != null ? r.ship_length : null,
      shipHeight: r.ship_height != null ? r.ship_height : null
    };
  });
}

async function couponPct(code, items) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return 0;
  const { data } = await supabase.from('discount_codes').select('*').eq('code', c).eq('active', true).limit(1);
  const row = data && data[0];
  if (!row || row.type !== 'pct') return 0;
  if (row.exp && new Date(row.exp) < new Date()) return 0;
  if (row.max_uses > 0 && (row.uses || 0) >= row.max_uses) return 0;
  if (row.scope === 'product' && !items.some(i => String(i.id) === String(row.scope_product_id))) return 0;
  return Math.max(0, Math.min(99, row.pct || 0));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });

  try {
    const b = JSON.parse(event.body || '{}');
    const { orderNum, email, name, phone, address, city, departamento, destinyDaneCode, productos, couponCode } = b;

    const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
    const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET;
    if (!WOMPI_PUBLIC_KEY) throw new Error('Falta configurar WOMPI_PUBLIC_KEY en las variables de entorno de Netlify');
    if (!WOMPI_INTEGRITY_SECRET) throw new Error('Falta configurar WOMPI_INTEGRITY_SECRET en las variables de entorno de Netlify (Dashboard Wompi > Desarrolladores > Secretos para integración técnica)');
    if (!/^FK-[0-9]{6,12}$/.test(String(orderNum || ''))) throw new Error('Número de pedido inválido');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw new Error('Email inválido');

    // 1. Total calculado en el servidor
    const items = await buildItems(productos);
    const subtotal = items.reduce((a, it) => a + it.subtotal, 0);
    const pct = await couponPct(couponCode, items);
    const discount = Math.round(subtotal * pct / 100);

    let shipping = null;
    let lock = null; // transportadora + precio cotizados aquí: se reutilizan al crear la guía
    if (destinyDaneCode) {
      try {
        const pkg = mipaquete.calculatePackageForCart(items);
        const { winner } = await mipaquete.quoteAllAndPickWinner({
          destinyDaneCode, declaredValue: Math.round(subtotal), quantity: 1,
          weight: pkg.weight, width: pkg.width, length: pkg.length, height: pkg.height
        });
        if (winner) { shipping = Math.round(winner.price); lock = { id: winner.carrierId, name: winner.carrierName }; }
      } catch (e) { console.warn('Re-cotización de envío falló, se usa el valor del cliente:', e.message); }
    }
    if (shipping == null) {
      const c = Math.round(Number(b.shipping));
      if (!(c >= 0 && c <= 200000)) throw new Error('No se pudo validar el costo de envío');
      shipping = c;
    }

    const total = Math.round(subtotal - discount + shipping);
    if (!(total >= 1500)) throw new Error('El total del pedido es inválido');

    // 2. Registrar la orden ANTES de pagar (el webhook la busca por order_num)
    const { error: dbError } = await supabase.from('orders').insert([{
      order_num: orderNum, email, name, phone, address,
      city: (city || '').trim().toUpperCase(),
      dept: departamento || null,
      destiny_dane_code: destinyDaneCode || null,
      items: JSON.stringify(items),
      total_cop: total,
      shipping_price: shipping,
      delivery_company_id: lock ? lock.id : null,
      delivery_company_name: lock ? lock.name : null,
      status: 'pending',
      payment_status: 'pending'
    }]);
    if (dbError) {
      console.error('Error insertando en Supabase:', dbError);
      throw new Error(`Error en base de datos: ${dbError.message}`);
    }

    // 3. Firma de integridad: SHA256("<referencia><monto><moneda><secreto>")
    const amountInCents = total * 100;
    const currency = 'COP';
    const signature = crypto.createHash('sha256').update(`${orderNum}${amountInCents}${currency}${WOMPI_INTEGRITY_SECRET}`).digest('hex');
    const cleanPhone = (phone || '').replace(/\D/g, '');

    return json(200, {
      total, subtotal, discount, shipping,
      widgetConfig: {
        currency, amountInCents, reference: orderNum, publicKey: WOMPI_PUBLIC_KEY,
        signature: { integrity: signature },
        redirectUrl: `${process.env.SITIO_WEB_URL}/?referenceCode=${orderNum}`,
        customerData: { email: email || '', fullName: name || '', phoneNumber: cleanPhone, phoneNumberPrefix: '+57' },
        shippingAddress: { addressLine1: address || '', city: city || '', phoneNumber: cleanPhone, region: departamento || '', country: 'CO' }
      }
    });
  } catch (error) {
    console.error('Error crítico en función wompi-checkout:', error.message);
    return json(500, { error: 'Error interno procesando el checkout', details: error.message });
  }
};
