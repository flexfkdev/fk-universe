// netlify/functions/mipaquete-delivery-companies.js
// Utilidad de DIAGNÓSTICO: muestra el listado de transportadoras que tu cuenta de
// Mi Paquete tiene disponibles, con su ID real. Ya no hace falta configurar ninguna
// manualmente — la selección de transportadora ahora es automática (ver lib/mipaquete.js,
// que cotiza contra todas y elige la más barata). Usá esta función solo para verificar
// que la lista de CARRIERS en lib/mipaquete.js siga coincidiendo con tu cuenta real.
//
// Cómo usarla: visitá en el navegador
//   https://TU-SITIO.netlify.app/.netlify/functions/mipaquete-delivery-companies
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { withAuth } = require('./lib/mipaquete-auth');

const MI_PAQUETE_BASE = process.env.MI_PAQUETE_BASE || 'https://api-v2.mpr.mipaquete.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  try {
    const data = await withAuth(async (token) => {
      const resp = await axios.get(`${MI_PAQUETE_BASE}/getDeliveryCompanies`, {
        headers: {
          apikey: token,
          'session-tracker': crypto.randomUUID()
        }
      });
      return resp.data;
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
