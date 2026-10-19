// netlify/functions/lib/shipping.js
// Lógica ÚNICA para crear la guía de un pedido ya pagado. La usan el webhook de Wompi
// y el panel admin de "Reintentar guía", así ambos se comportan igual.
//
// Flujo: el cliente ya pagó el envío dentro del total de Wompi. Aquí se usa la MISMA
// transportadora y precio que se cotizaron en el checkout (quedan guardados en la orden),
// y se crea la guía en Mi Paquete (prepago: descuenta del saldo de la cuenta Mi Paquete).
'use strict';

const mipaquete = require('./mipaquete');
const { updateOrder, saveShipmentResult, logShipmentEvent } = require('./orders');

function parseItems(orden) {
  try { return typeof orden.items === 'string' ? JSON.parse(orden.items) : (orden.items || []); } catch (e) { return []; }
}

function errDetail(err) {
  return err && err.response ? JSON.stringify(err.response.data) : (err && err.message) || String(err);
}

function isBalanceError(detail) {
  return /saldo|balance|insufficient|fondos/i.test(detail || '');
}

// Transportadora ya cotizada en el checkout (precio que pagó el cliente)
function lockedCarrier(orden) {
  if (orden.delivery_company_id && orden.shipping_price) {
    return { carrierId: orden.delivery_company_id, carrierName: orden.delivery_company_name, price: Number(orden.shipping_price), locked: true };
  }
  return null;
}

async function freshCarrier(orden) {
  const pkg = mipaquete.calculatePackageForCart(parseItems(orden));
  const { winner, allQuotes } = await mipaquete.quoteAllAndPickWinner({
    destinyDaneCode: orden.destiny_dane_code,
    declaredValue: orden.total_cop,
    quantity: 1,
    weight: pkg.weight, width: pkg.width, length: pkg.length, height: pkg.height
  });
  await logShipmentEvent(orden.order_num, 'quote', winner ? 'quoted' : 'quote_failed', { allQuotes });
  return winner ? { ...winner, locked: false } : null;
}

async function createGuide(orden, carrier) {
  const resp = await mipaquete.crearEnvio(orden, carrier.carrierId);
  const trackingNumber = resp.mpCode || resp.trackingNumber || resp.guideNumber || null;
  const shipmentId = resp._id || resp.id || null;
  await saveShipmentResult(orden.order_num, {
    carrierId: carrier.carrierId, carrierName: carrier.carrierName, price: carrier.price,
    trackingNumber, shipmentId, status: 'created'
  });
  await logShipmentEvent(orden.order_num, 'created', 'created', { trackingNumber, shipmentId, carrier: carrier.carrierName, locked: !!carrier.locked });
  return { success: true, trackingNumber, carrierName: carrier.carrierName };
}

/**
 * Crea la guía del pedido. Lanza el error de Mi Paquete si falla (el caller llama a recordShipmentFailure).
 * Si la transportadora bloqueada falla por algo que NO es saldo, reintenta con una cotización nueva.
 */
async function processShipment(orden) {
  const locked = lockedCarrier(orden);
  if (locked) {
    try {
      return await createGuide(orden, locked);
    } catch (err) {
      if (isBalanceError(errDetail(err))) throw err;
      console.warn(`Transportadora bloqueada falló para ${orden.order_num}, se recotiza:`, errDetail(err));
    }
  }
  const carrier = await freshCarrier(orden);
  if (!carrier) {
    await updateOrder(orden.order_num, { shipping_status: 'failed' });
    return { success: false, reason: 'no_quotes' };
  }
  return createGuide(orden, carrier);
}

/** Marca el pedido como fallido (distingue falta de saldo) y deja registro de auditoría. */
async function recordShipmentFailure(orderNum, err) {
  const detail = errDetail(err);
  const noBalance = isBalanceError(detail);
  const status = noBalance ? 'failed_no_balance' : 'failed';
  await updateOrder(orderNum, { shipping_status: status });
  await logShipmentEvent(orderNum, 'error', status, { error: detail });
  console.error('Error generando el envío:', detail);
  return { isBalanceError: noBalance, status, detail };
}

module.exports = { processShipment, recordShipmentFailure, isBalanceError, errDetail };
