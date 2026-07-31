// netlify/functions/mipaquete-quote.js
// Cotiza el costo real de envío antes del pago (POST /quoteShipping en Mi Paquete).
const axios = require('axios');
const crypto = require('crypto');

const MI_PAQUETE_BASE = process.env.MI_PAQUETE_BASE || 'https://api-v2.dev.mpr.mipaquete.com';
const MI_PAQUETE_APIKEY = process.env.MI_PAQUETE_API_KEY;

const MP_ORIGIN_DANE_CODE = process.env.MI_PAQUETE_ORIGIN_DANE_CODE;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  try {
    const { destinyDaneCode, declaredValue, weight, width, height, length, quantity } = JSON.parse(event.body || '{}');

    if (!destinyDaneCode) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Falta destinyDaneCode' })
      };
    }

    const payload = {
      originCountryCode: '484',
      originLocationCode: MP_ORIGIN_DANE_CODE,
      destinyCountryCode: '484',
      destinyLocationCode: destinyDaneCode,
      quantity: quantity || 1,
      width: width || 15,
      length: length || 20,
      height: height || 10,
      weight: weight || 1,
      declaredValue: declaredValue || 0
    };

    const { data } = await axios.post(`${MI_PAQUETE_BASE}/quoteShipping`, payload, {
      headers: {
        apikey: MI_PAQUETE_APIKEY,
        'session-tracker': crypto.randomUUID(),
        'Content-Type': 'application/json'
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    };

  } catch (error) {
    console.error('Error cotizando envío en Mi Paquete:', error.response ? JSON.stringify(error.response.data) : error.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No se pudo cotizar el envío' })
    };
  }
};
