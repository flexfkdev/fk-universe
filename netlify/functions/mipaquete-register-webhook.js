// netlify/functions/mipaquete-register-webhook.js
// Utilidad de un solo uso: registra ante Mi Paquete la URL que debe recibir las
// actualizaciones de estado (POST /createWebHook, confirmado en su documentación).
//
// Cómo usarla: una sola vez, visitá en el navegador (o hacé un POST vacío con curl/Postman)
//   https://TU-SITIO.netlify.app/.netlify/functions/mipaquete-register-webhook
// Esto le dice a Mi Paquete que mande los cambios de estado a mipaquete-webhook.js.
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { withAuth } = require('./lib/mipaquete-auth');

const MI_PAQUETE_BASE = process.env.MI_PAQUETE_BASE || 'https://api-v2.mpr.mipaquete.com';
const SITIO_WEB_URL = process.env.SITIO_WEB_URL || '';

exports.handler = async (event) => {
  try {
    const webhookUrl = `${SITIO_WEB_URL}/.netlify/functions/mipaquete-webhook`;

    const data = await withAuth(async (token) => {
      const resp = await axios.post(`${MI_PAQUETE_BASE}/createWebHook`, {
        urlForStates: {
          urlClient: webhookUrl,
          enabled: true
        }
      }, {
        headers: {
          apikey: token,
          'session-tracker': crypto.randomUUID(),
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      return resp.data;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registered: webhookUrl, response: data })
    };
  } catch (error) {
    console.error('Error registrando webhook en Mi Paquete:', error.response ? JSON.stringify(error.response.data) : error.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No se pudo registrar el webhook', detail: error.response ? error.response.data : error.message })
    };
  }
};
