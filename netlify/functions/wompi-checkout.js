// netlify/functions/wompi-checkout.js
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Inicializamos el cliente de Supabase usando las variables de entorno de Netlify
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  // Aseguramos que solo se permitan peticiones de tipo POST
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Método no permitido' }) 
    };
  }

  try {
    // Desestructuramos los datos enviados desde el frontend (HTML)
    const { orderNum, total, email, name, phone, address, city, departamento, productos } = JSON.parse(event.body);
    
    // Obtenemos la llave pública de Wompi (pub_test_... o pub_prod_...)
    const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
    
    // IMPORTANTE: Wompi requiere obligatoriamente el monto total expresado en centavos.
    // Ejemplo: $50.000 COP se debe enviar como 5000000
    const totalEnCentavos = Math.round(parseFloat(total) * 100);

    // 1. Registramos la orden de compra en Supabase en estado 'PENDING'
    // De esta manera respaldamos los datos de envío antes de que el cliente vaya a pagar
    const { error: dbError } = await supabase
      .from('ordenes')
      .insert([{
        id_orden: orderNum,
        email,
        name,
        phone,
        address,
        city: city.trim().toUpperCase(), // Normalizamos la ciudad en mayúsculas para la transportadora
        departamento,
        total: parseFloat(total),
        productos: JSON.stringify(productos || []), // Guardamos el detalle del merch comprado
        estado_pago: 'PENDING'
      }]);

    // Si ocurre un error guardando en Supabase, detenemos el proceso
    if (dbError) {
      console.error('Error insertando en Supabase:', dbError);
      throw new Error(`Error en base de datos: ${dbError.message}`);
    }

    // 2. Realizamos la petición HTTP POST a la API oficial de Wompi
    // para generar un enlace de pago único y dinámico (Web Checkout)
    const responseWompi = await axios.post('https://wompi.co', {
      name: `Pedido FlexFK #${orderNum}`,
      description: `Compra de Merch Oficial Flex FK`,
      single_use: true, // El enlace se inhabilita una vez se complete el pago
      collect_shipping_legal_id: false,
      amount_in_cents: totalEnCentavos,
      currency: "COP",
      reference: orderNum, // Tu código único de factura para enlazar el Webhook
      redirection_url: `${process.env.URL}/checkout/respuesta` // Página a donde vuelve el usuario al finalizar
    }, {
      headers: { 
        'Authorization': `Bearer ${WOMPI_PUBLIC_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    // 3. Extraemos la URL de redirección segura provista por Wompi
    const urlRedireccion = responseWompi.data.data.initiation_url;

    // Retornamos la URL al frontend para que el JavaScript del HTML redirija al usuario
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlRedireccion })
    };

  } catch (error) {
    console.error('Error crítico en función wompi-checkout:', error.message);
    
    // Si la API de Wompi devolvió un error específico, lo imprimimos en logs de Netlify
    if (error.response) {
      console.error('Detalle error API Wompi:', error.response.data);
    }

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
