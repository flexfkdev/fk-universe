// netlify/functions/mipaquete-diagnostic.js
// Solo admin. Hace una cotización REAL contra Mi Paquete (todas las transportadoras, ambos códigos
// de país) y devuelve el precio interpretado junto a la respuesta cruda, para verificar que el costo
// de envío del sitio coincide con lo que dice Mi Paquete.
//   GET ?destiny=11001&cat=Hoodies&qty=1&declared=90000
'use strict';

const { requireAdmin } = require('./lib/admin-auth');
const mp = require('./lib/mipaquete');

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (!(await requireAdmin(event))) return json(403, { error: 'No autorizado' });
  const q = event.queryStringParameters || {};
  const destiny = String(q.destiny || '').replace(/\D/g, '');
  if (!destiny) return json(400, { error: 'Falta destiny (código DANE)' });

  const qty = Math.max(1, parseInt(q.qty, 10) || 1);
  const pkg = mp.calculatePackageForCart([{ cat: q.cat || 'Otro', qty }]);
  const params = { destinyDaneCode: destiny, declaredValue: Number(q.declared) || 0, quantity: 1, ...pkg };

  const rows = [];
  for (const cc of mp.COUNTRY_CODES) {
    const results = await Promise.all(mp.CARRIERS.map(async (c) => {
      const r = await mp.rawQuote(c, params, cc);
      const parsed = r.ok ? mp.extractQuote(r.data, c) : null;
      return {
        carrier: c.name, countryCode: cc, http: r.status,
        price: parsed ? parsed.price : null, days: parsed ? parsed.deliveryDays : null,
        raw: JSON.stringify(r.data).slice(0, 700)
      };
    }));
    rows.push(...results);
  }
  return json(200, { sent: { ...mp.normalizeParams(params), destiny, origin: process.env.MI_PAQUETE_ORIGIN_DANE_CODE || null }, rows });
};
