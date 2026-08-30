// netlify/functions/wompi-checkout.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
    //    Se genera SIEMPRE en el servidor, nunca en el frontend (evita exponer el secreto).
    const cadenaConcatenada = `${orderNum}${amountInCents}${currency}${WOMPI_INTEGRITY_SECRET}`;
    const signature = crypto.createHash('sha256').update(cadenaConcatenada).digest('hex');

    // 3. Devolvemos al frontend el objeto de configuración listo para instanciar
    //    `new WidgetCheckout({...})` (Widget con botón personalizado — el cliente
    //    completa el pago sin salir del sitio).
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widgetConfig: {
          currency,
          amountInCents,
          reference: orderNum,
          publicKey: WOMPI_PUBLIC_KEY,
          signature: { integrity: signature },
          redirectUrl: `${process.env.SITIO_WEB_URL}/?referenceCode=${orderNum}`,
          customerData: {
            email: email || '',
            fullName: name || '',
            phoneNumber: (phone || '').replace(/\D/g, ''),
            phoneNumberPrefix: '+57'
          },
          shippingAddress: {
            addressLine1: address || '',
            city: city || '',
            phoneNumber: (phone || '').replace(/\D/g, ''),
            region: departamento || '',
            country: 'CO'
          }
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
