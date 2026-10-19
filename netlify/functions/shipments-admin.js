// netlify/functions/shipments-admin.js
// Panel admin de pedidos y envíos (solo admin autenticado).
//   GET  → últimos pedidos con su estado de pago y envío
//   POST → { order_num } reintenta crear la guía (útil tras recargar saldo en Mi Paquete)
'use strict';

const { requireAdmin } = require('./lib/admin-auth');
const { supabase, getOrderByNum, logShipmentEvent, updateOrder } = require('./lib/orders');
const { processShipment, recordShipmentFailure } = require('./lib/shipping');
const { sendOrderStatusEmail } = require('./lib/email');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const FIELDS = 'order_num,name,city,total_cop,payment_status,status,shipping_status,tracking_number,delivery_company_name,shipping_price,created_at';

exports.handler = async (event) => {
  if (!(await requireAdmin(event))) return json(403, { error: 'No autorizado' });

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from('orders').select(FIELDS).order('created_at', { ascending: false }).limit(60);
    if (error) return json(500, { error: 'No se pudieron leer los pedidos' });
    return json(200, { data: data || [] });
  }

  if (event.httpMethod === 'POST') {
    let orderNum = '';
    try { orderNum = String(JSON.parse(event.body || '{}').order_num || ''); } catch (e) {}
    const orden = await getOrderByNum(orderNum);
    if (!orden) return json(404, { error: 'Pedido no encontrado' });
    if (orden.payment_status !== 'approved') return json(400, { error: 'El pedido aún no tiene pago aprobado' });
    if (orden.tracking_number) return json(400, { error: 'Este pedido ya tiene guía' });
    if (orden.status === 'review') return json(400, { error: 'Pedido en revisión manual (el monto pagado no coincide)' });

    try {
      const result = await processShipment(orden);
      if (!result.success) return json(200, { success: false, reason: result.reason });
      const mail = await sendOrderStatusEmail({
        to: orden.email, orderNum: orden.order_num, name: orden.name, statusKey: 'created',
        carrierName: result.carrierName, trackingNumber: result.trackingNumber
      });
      await updateOrder(orden.order_num, { last_email_sent_at: new Date().toISOString(), last_email_status: mail.ok ? 'sent' : 'failed' });
      await logShipmentEvent(orden.order_num, 'retry', 'created', { trackingNumber: result.trackingNumber });
      return json(200, { success: true, trackingNumber: result.trackingNumber, carrierName: result.carrierName });
    } catch (err) {
      const r = await recordShipmentFailure(orden.order_num, err);
      return json(200, { success: false, reason: r.isBalanceError ? 'no_balance' : 'error', detail: r.detail });
    }
  }
  return json(405, { error: 'Método no permitido' });
};
