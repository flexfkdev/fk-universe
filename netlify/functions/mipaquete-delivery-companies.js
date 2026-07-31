// netlify/functions/mipaquete-delivery-companies.js
// Utilidad para obtener el listado de transportadoras disponibles en tu cuenta de
// Mi Paquete, junto con su ID real (el campo "deliveryCompany" que pide /createSending).
//
// Cómo usarla: visitá manualmente en el navegador
//   https://TU-SITIO.netlify.app/.netlify/functions/mipaquete-delivery-companies
// copiá el "_id" de la transportadora que vas a usar, y ponelo como valor de la
// variable de entorno MI_PAQUETE_DELIVERY_COMPANY en Netlify.
const axios = require('axios');
const crypto = require('crypto');

const MI_PAQUETE_BASE = process.env.MI_PAQUETE_BASE || 'https://api-v2.dev.mpr.mipaquete.com';
const MI_PAQUETE_APIKEY = process.env.MI_PAQUETE_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  try {
    const { data } = await axios.get(`${MI_PAQUETE_BASE}/getDeliveryCompanies`, {
      headers: {
        apikey: MI_PAQUETE_APIKEY,
        'session-tracker': crypto.randomUUID()
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    };

  } catch (error) {
    console.error('Error consultando transportadoras en Mi Paquete:', error.response ? JSON.stringify(error.response.data) : error.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No se pudo obtener el listado de transportadoras' })
    };
  }
};
