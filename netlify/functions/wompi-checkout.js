// netlify/functions/wompi-checkout.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Wompi Web Checkout — confirmado en la documentación oficial:
// https://docs.wompi.co/docs/colombia/widget-checkout-web/
// El comercio redirige al cliente con un formulario HTML estándar hacia:
//   https://checkout.wompi.co/p/
// No existe un endpoint de "Payment Links" para este flujo — Wompi entrega la URL
// y los campos, y el navegador del cliente hace el submit.
const WOMPI_CHECKOUT_URL = 'https://checkout.wompi.co/p/';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  }

  try {
    const { orderNum, total, email, name, phone, address, city, departamento, destinyDaneCode, productos } = JSON.parse(event.body);

    const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
    const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET;

    if (!WOMPI_PUBLIC_KEY) {
      throw new Error('Falta configurar WOMPI_PUBLIC_KEY en las variables de entorno de Netlify');
    }
    if (!WOMPI_INTEGRITY_SECRET) {
      throw new Error('Falta configurar WOMPI_INTEGRITY_SECRET en las variables de entorno de Netlify (Dashboard Wompi > Desarrolladores > Secretos para integración técnica)');
    }
    if (!orderNum || !total) {
      throw new Error('Faltan datos del pedido (orderNum o total)');
    }

    // Wompi requiere el monto total en CENTAVOS (COP)
    const amountInCents = Math.round(parseFloat(total) * 100);
    const currency = 'COP';

    // 1. Registramos la orden en Supabase (tabla real: 'orders') ANTES de mandar al
    //    cliente a pagar, así el webhook (wompi-confirmation) siempre encuentra la orden.
    const { error: dbError } = await supabase
      .from('orders')
      .insert([{
        order_num: orderNum,
        email,
        name,
        phone,
        address,
        city: (city || '').trim().toUpperCase(),
        dept: departamento || null,
        destiny_dane_code: destinyDaneCode || null,
        items: JSON.stringify(productos || []),
        total_cop: parseFloat(total),
        status: 'pending',
        payment_status: 'pending'
      }]);

    if (dbError) {
      console.error('Error insertando en Supabase:', dbError);
      throw new Error(`Error en base de datos: ${dbError.message}`);
    }

    // 2. Generamos la firma de integridad: SHA256("<referencia><monto><moneda><secreto>")
    //    Confirmado en la documentación oficial — el orden de concatenación importa.
    const cadenaConcatenada = `${orderNum}${amountInCents}${currency}${WOMPI_INTEGRITY_SECRET}`;
    const signature = crypto.createHash('sha256').update(cadenaConcatenada).digest('hex');

    // 3. Devolvemos al frontend todo lo necesario para construir el <form> de redirección.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkoutUrl: WOMPI_CHECKOUT_URL,
        fields: {
          'public-key': WOMPI_PUBLIC_KEY,
          currency,
          'amount-in-cents': String(amountInCents),
          reference: orderNum,
          'signature:integrity': signature,
          'redirect-url': `${process.env.SITIO_WEB_URL}/?referenceCode=${orderNum}`,
          'customer-data:email': email || '',
          'customer-data:full-name': name || '',
          'customer-data:phone-number': (phone || '').replace(/\D/g, ''),
          'customer-data:phone-number-prefix': '+57',
          'shipping-address:address-line-1': address || '',
          'shipping-address:country': 'CO',
          'shipping-address:city': city || '',
          'shipping-address:region': departamento || '',
          'shipping-address:phone-number': (phone || '').replace(/\D/g, '')
        }
      })
    };

  } catch (error) {
    console.error('Error crítico en función wompi-checkout:', error.message);

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Error interno procesando el checkout',
        details: error.message
      })
    };
  }
};
