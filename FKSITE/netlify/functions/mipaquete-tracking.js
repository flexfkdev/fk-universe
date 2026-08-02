// netlify/functions/mipaquete-tracking.js
// Consulta el estado real de una guía en Mi Paquete (GET /getSendingTracking?mpCode=...)
'use strict';

const { getTracking } = require('./lib/mipaquete');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  const mpCode = event.queryStringParameters && event.queryStringParameters.mpCode;
  if (!mpCode) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Falta el parámetro mpCode' })
    };
  }

  try {
    const data = await getTracking(mpCode);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    };
  } catch (error) {
    console.error('Error consultando tracking en Mi Paquete:', error.response ? JSON.stringify(error.response.data) : error.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No se pudo obtener el estado del envío' })
    };
  }
};
