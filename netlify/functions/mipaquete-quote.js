// netlify/functions/mipaquete-quote.js
// Cotiza el envío contra TODAS las transportadoras habilitadas y devuelve la
// ganadora automática (menor precio; empate -> menor tiempo de entrega). Este es
// el mismo criterio y la misma función que se usa al crear la guía real después
// del pago, así el precio mostrado en el checkout siempre coincide con el cobrado.
//
// Recibe los items del carrito ([{cat, qty}]) y calcula las medidas del paquete
// con la MISMA función que usa la creación real del envío (calculatePackageForCart),
// para que no haya divergencia entre lo cotizado y lo efectivamente enviado.
'use strict';

const { quoteAllAndPickWinner, calculatePackageForCart } = require('./lib/mipaquete');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método no permitido' };
  }

  try {
    const { destinyDaneCode, declaredValue, items } = JSON.parse(event.body || '{}');

    if (!destinyDaneCode) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Falta destinyDaneCode' })
      };
    }

    const pkg = calculatePackageForCart(items || []);

    const { winner, allQuotes } = await quoteAllAndPickWinner({
      destinyDaneCode,
      declaredValue,
      quantity: 1,
      weight: pkg.weight,
      width: pkg.width,
      length: pkg.length,
      height: pkg.height
    });

    if (!winner) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: null, error: 'Ninguna transportadora cotizó esta ruta' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          price: winner.price,
          carrierId: winner.carrierId,
          carrierName: winner.carrierName,
          deliveryDays: winner.deliveryDays
        },
        package: pkg,
        allQuotes: allQuotes.map(q => ({ carrierName: q.carrierName, price: q.price, deliveryDays: q.deliveryDays }))
      })
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
