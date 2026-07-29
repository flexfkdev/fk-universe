// netlify/functions/wompi-confirmation.js
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MI_PAQUETE_API_KEY = process.env.MI_PAQUETE_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  try {
    const body = JSON.parse(event.body);
    
    // Leemos las propiedades enviadas por el servidor de Wompi
    const evento = body.event; // "transaction.updated"
    const transaccion = body.data.transaction;
    
    const estadoWompi = transaccion.status; // "APPROVED", "DECLINED", etc.
    const referenciaOrden = transaccion.reference; // Tu orderNum original

    // 1. Verificamos si la transacción fue aprobada de verdad
    if (evento === "transaction.updated" && estadoWompi === "APPROVED") {
      
      // 2. Buscamos la orden guardada en Supabase para obtener los datos de envío
      const { data: orden, error: dbError } = await supabase
        .from('ordenes')
        .select('*')
        .eq('id_orden', referenciaOrden)
        .single();

      // Procedemos solo si la orden existe y aún está 'PENDING'
      if (orden && orden.estado_pago === 'PENDING') {
        try {
          // 3. Generamos la guía logística llamando a la API de Mi Paquete
          const respuestaMiPaquete = await axios.post('https://mipaquete.com', {
            origen: "BOGOTA", // Coloca tu ciudad de despacho en mayúsculas
            destino: orden.city.trim().toUpperCase(),
            direccionDestino: orden.address,
            nombreDestinatario: orden.name,
            telefonoDestinatario: orden.phone,
            descripcionMercancia: "Merch Oficial Flex FK",
            valorDeclarado: orden.total,
            idOrdenTienda: orden.id_orden
          }, { 
            headers: { 'Authorization': MI_PAQUETE_API_KEY } 
          });

          // Extraemos los datos de la guía generada
          const numeroGuia = respuestaMiPaquete.data.trackingNumber;
          const urlPdfGuia = respuestaMiPaquete.data.pdfUrl;

          // 4. Actualizamos Supabase con la confirmación de pago y datos de envío
          await supabase
            .from('ordenes')
            .update({ 
              estado_pago: 'APPROVED',
              numero_guia: numeroGuia,
              url_pdf_guia: urlPdfGuia
            })
            .eq('id_orden', referenciaOrden);

          console.log(`Automatización exitosa para orden #${referenciaOrden}`);

        } catch (apiError) {
          console.error("Error en la API de Mi Paquete:", apiError.message);
          
          // PLAN DE RESPALDO: Si el pago es real pero la transportadora falla,
          // cambiamos el estado para que puedas procesar la guía de forma manual.
          await supabase
            .from('ordenes')
            .update({ estado_pago: 'APPROVED_MANUAL_SHIPPING' })
            .eq('id_orden', referenciaOrden);
        }
      }
    }

    // Wompi requiere un código HTTP 200 para dar por exitosa la entrega del evento
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
