// netlify/functions/lib/mipaquete.js
// Módulo reutilizable para interactuar con la API de Mi Paquete v2.
// URL de producción confirmada: https://api-v2.mpr.mipaquete.com
//
// Autenticación: usa lib/mipaquete-auth.js, que maneja el login dinámico
// (email+password -> apikey) y la renovación automática si el token es rechazado.
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { withAuth, getAccountUserId } = require('./mipaquete-auth');

const MI_PAQUETE_BASE = process.env.MI_PAQUETE_BASE || 'https://api-v2.mpr.mipaquete.com';

const MP_ORIGIN_DANE_CODE = process.env.MI_PAQUETE_ORIGIN_DANE_CODE; // 5 dígitos, ej. '11001'
const MP_SENDER_NAME = process.env.MI_PAQUETE_SENDER_NAME || 'Flex FK';
const MP_SENDER_SURNAME = process.env.MI_PAQUETE_SENDER_SURNAME || '.';
const MP_SENDER_NIT = process.env.MI_PAQUETE_SENDER_NIT;
const MP_SENDER_NIT_TYPE = process.env.MI_PAQUETE_SENDER_NIT_TYPE || 'NIT';
const MP_SENDER_EMAIL = process.env.MI_PAQUETE_SENDER_EMAIL;
const MP_SENDER_PHONE = process.env.MI_PAQUETE_SENDER_PHONE;
const MP_SENDER_ADDRESS = process.env.MI_PAQUETE_SENDER_ADDRESS;
// El "user" que pide /createSending es el _id de la propia cuenta autenticada —
// se extrae automáticamente del token (ver getAccountUserId), no hace falta configurarlo.

// Mi Paquete exige un valor declarado mínimo de $10.000 (publicado en mipaquete.com).
const MIN_DECLARED_VALUE = 10000;

// Código de país que se envía a /quoteShipping. Se prueba primero el configurado
// (MI_PAQUETE_COUNTRY_CODE, por defecto el que ya usabas) y, si la API lo rechaza con un
// 400/404/422, se reintenta con el otro. El que funcione se recuerda mientras la función esté "caliente".
const COUNTRY_CODES = [process.env.MI_PAQUETE_COUNTRY_CODE || '484', '170'].filter((v, i, a) => a.indexOf(v) === i);
let workingCountry = null;

// Transportadoras habilitadas para cotizar automáticamente. IDs confirmados
// vía GET /getDeliveryCompanies contra la cuenta real.
const CARRIERS = [
  { id: '5ca22d9587981510092322f6', name: 'TCC' },
  { id: '5fceb46c8229797cb139a7aa', name: 'SERVIENTREGA' },
  { id: '5cb0f5fd244fe2796e65f9fc', name: 'COORDINADORA' },
  { id: '6080a75ef08a770ddd9724fd', name: 'ENVIA' },
  { id: '64baafead968aa4f73ce67c5', name: 'INTER RAPIDÍSIMO' }
];

// Medidas y peso de empaque por categoría de producto, confirmados por el
// merchant. Se usan para calcular el paquete combinado de un carrito con
// varios productos (ver calculatePackageForCart).
const PACKAGE_BY_CATEGORY = {
  'Camisetas':   { weight: 0.35, width: 28, length: 35, height: 10 }, // 300-400g, caja 35x28x10
  'Hoodies':     { weight: 0.8,  width: 28, length: 35, height: 10 }, // 700-900g, caja 35x28x10
  'Buzos':       { weight: 0.8,  width: 28, length: 35, height: 10 }, // alias de Hoodies en el catálogo
  'Discos':      { weight: 0.15, width: 33, length: 33, height: 5  }, // 100-200g, caja rígida 33x33x5
  'Accesorios':  { weight: 0.3,  width: 25, length: 25, height: 8  }, // peso variable -> valor conservador
  'Otro':        { weight: 0.35, width: 28, length: 35, height: 10 }  // fallback genérico
};
const DEFAULT_PACKAGE = PACKAGE_BY_CATEGORY['Otro'];

/**
 * Resuelve el peso/medidas de UN item: usa el override individual del producto
 * si está definido (shipWeight/shipWidth/shipLength/shipHeight), y si no, cae
 * en el valor genérico de su categoría.
 */
function resolveItemPackage(item) {
  const catPkg = PACKAGE_BY_CATEGORY[item.cat] || DEFAULT_PACKAGE;
  return {
    weight: item.shipWeight != null && item.shipWeight !== '' ? Number(item.shipWeight) : catPkg.weight,
    width: item.shipWidth != null && item.shipWidth !== '' ? Number(item.shipWidth) : catPkg.width,
    length: item.shipLength != null && item.shipLength !== '' ? Number(item.shipLength) : catPkg.length,
    height: item.shipHeight != null && item.shipHeight !== '' ? Number(item.shipHeight) : catPkg.height
  };
}

/**
 * Calcula el paquete combinado (peso total + caja necesaria) para un carrito con
 * varios productos. items: [{ cat, qty, shipWeight?, shipWidth?, shipLength?, shipHeight? }].
 * El peso se SUMA (todo el pedido pesa junto); las dimensiones toman la caja más
 * grande necesaria entre los productos presentes (asume que todo se empaca junto
 * en el envío más grande requerido). Si un producto tiene sus propias medidas
 * cargadas (override individual), se usan esas en vez de las de su categoría.
 */
function calculatePackageForCart(items) {
  let totalWeight = 0;
  let maxWidth = 0, maxLength = 0, maxHeight = 0;

  (items || []).forEach(item => {
    const pkg = resolveItemPackage(item);
    const qty = item.qty || 1;
    totalWeight += pkg.weight * qty;
    if (pkg.width > maxWidth) maxWidth = pkg.width;
    if (pkg.length > maxLength) maxLength = pkg.length;
    if (pkg.height > maxHeight) maxHeight = pkg.height;
  });

  if (!totalWeight) {
    return { weight: DEFAULT_PACKAGE.weight, width: DEFAULT_PACKAGE.width, length: DEFAULT_PACKAGE.length, height: DEFAULT_PACKAGE.height };
  }

  // Si hay más de una unidad en total, la altura crece proporcionalmente
  // (varias prendas apiladas), con un mínimo razonable y sin desbordar de más.
  const totalQty = (items || []).reduce((a, it) => a + (it.qty || 1), 0);
  const stackedHeight = Math.min(maxHeight * Math.max(1, Math.ceil(totalQty / 3)), 40);

  return {
    weight: Math.round(totalWeight * 100) / 100,
    width: maxWidth,
    length: maxLength,
    height: stackedHeight
  };
}

/**
 * Normaliza los parámetros que SIEMPRE deben ser idénticos entre la cotización del checkout,
 * la re-cotización del servidor y la creación de la guía (así el precio cobrado coincide con el
 * que se contrata): medidas enteras hacia arriba (nunca cotizar menos de lo que se enviará),
 * peso con 2 decimales, y valor declarado con el mínimo de Mi Paquete.
 */
function normalizeParams(params) {
  const p = params || {};
  return {
    quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
    width: Math.max(1, Math.ceil(Number(p.width) || 15)),
    length: Math.max(1, Math.ceil(Number(p.length) || 20)),
    height: Math.max(1, Math.ceil(Number(p.height) || 10)),
    weight: Math.max(0.1, Math.round((Number(p.weight) || 1) * 100) / 100),
    declaredValue: Math.max(MIN_DECLARED_VALUE, Math.round(Number(p.declaredValue) || 0))
  };
}

/**
 * Mi Paquete usa "locationCode" de 8 dígitos (código DANE de 5 dígitos + "000"),
 * confirmado en su documentación de /getLocations (ej. Amalfi = 05031 -> 05031000).
 * Si ya viene con 8 dígitos no se toca; si viene con 5, se completa.
 */
function toLocationCode(daneCode) {
  const clean = String(daneCode || '').replace(/\D/g, '');
  if (!clean) return '';
  if (clean.length >= 8) return clean;
  return clean.padEnd(8, '0');
}

function mpHeaders(token) {
  return {
    apikey: token,
    'session-tracker': crypto.randomUUID(),
    'Content-Type': 'application/json'
  };
}

const PRICE_KEYS = ['price', 'total', 'value', 'shippingCost', 'deliveryPrice', 'cost', 'freight'];
const DAYS_KEYS = ['deliveryDays', 'days', 'estimatedDays', 'deliveryTime'];

function firstPositive(obj, keys) {
  for (const k of keys) {
    const n = Number(obj && obj[k]);
    if (n > 0) return n;
  }
  return 0;
}

/**
 * Extrae la mejor cotización de la respuesta de /quoteShipping. La respuesta puede ser un objeto,
 * un arreglo, o venir dentro de { data }. Si trae varias opciones, se prefieren las de la
 * transportadora consultada y se toma la más barata con precio válido.
 */
function extractQuote(data, carrier) {
  let list = Array.isArray(data) ? data
    : (data && Array.isArray(data.data) ? data.data : (data && data.data ? [data.data] : (data ? [data] : [])));
  list = list.filter(q => q && typeof q === 'object');
  const mine = list.filter(q => [q.deliveryCompany, q.deliveryCompanyId, q.carrierId].some(v => v && String(v) === carrier.id));
  if (mine.length) list = mine;
  const priced = list.map(q => ({ q, price: firstPositive(q, PRICE_KEYS), days: firstPositive(q, DAYS_KEYS) || 99 })).filter(x => x.price > 0);
  if (!priced.length) return null;
  priced.sort((a, b) => a.price - b.price);
  return { price: Math.round(priced[0].price), deliveryDays: priced[0].days, raw: priced[0].q };
}

function buildQuotePayload(carrier, params, countryCode) {
  const p = normalizeParams(params);
  return {
    originCountryCode: countryCode,
    originLocationCode: toLocationCode(MP_ORIGIN_DANE_CODE),
    destinyCountryCode: countryCode,
    destinyLocationCode: toLocationCode(params.destinyDaneCode),
    deliveryCompany: carrier.id,
    quantity: p.quantity,
    width: p.width,
    length: p.length,
    height: p.height,
    weight: p.weight,
    declaredValue: p.declaredValue
  };
}

/** Llamada cruda a /quoteShipping (la usa el diagnóstico del panel admin). */
async function rawQuote(carrier, params, countryCode) {
  try {
    const data = await withAuth(async (token) => {
      const resp = await axios.post(`${MI_PAQUETE_BASE}/quoteShipping`, buildQuotePayload(carrier, params, countryCode), {
        headers: mpHeaders(token), timeout: 10000
      });
      return resp.data;
    });
    return { ok: true, status: 200, data };
  } catch (err) {
    return { ok: false, status: err.response ? err.response.status : 0, data: err.response ? err.response.data : err.message };
  }
}

// Caché corta (5 min) por instancia: el precio que ve el cliente en el checkout y el que se re-valida
// al pagar salen de la misma consulta, y se evitan llamadas repetidas mientras el cliente cambia datos.
const quoteCache = new Map();
const CACHE_MS = 5 * 60 * 1000;

/**
 * Cotiza el envío contra UNA transportadora específica.
 * Devuelve null si esa transportadora falla o no cotiza esta ruta (no lanza error,
 * para que el resto de cotizaciones pueda seguir intentándose).
 * Reintenta una vez ante timeouts / errores 5xx, y prueba el otro código de país si la API
 * rechaza los parámetros (400/404/422).
 */
async function quoteOne(carrier, params) {
  const p = normalizeParams(params);
  const key = [carrier.id, MP_ORIGIN_DANE_CODE, params.destinyDaneCode, p.quantity, p.width, p.length, p.height, p.weight, p.declaredValue].join('|');
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  const codes = workingCountry ? [workingCountry] : COUNTRY_CODES;
  for (const cc of codes) {
    let rejected = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await rawQuote(carrier, params, cc);
      if (r.ok) {
        const q = extractQuote(r.data, carrier);
        if (!q) {
          console.warn(`Sin precio válido para ${carrier.name} (país ${cc}). Respuesta:`, JSON.stringify(r.data).slice(0, 400));
          return null;
        }
        workingCountry = cc;
        const result = { carrierId: carrier.id, carrierName: carrier.name, price: q.price, deliveryDays: q.deliveryDays, raw: q.raw };
        quoteCache.set(key, { t: Date.now(), v: result });
        return result;
      }
      const transient = r.status === 0 || r.status >= 500 || r.status === 408 || r.status === 429;
      if (transient && attempt === 0) continue; // un reintento
      if ([400, 404, 422].includes(r.status)) { rejected = true; }
      console.warn(`Cotización falló para ${carrier.name} (país ${cc}, HTTP ${r.status}):`, JSON.stringify(r.data).slice(0, 300));
      break;
    }
    if (!rejected) return null; // error que no es de parámetros: no sirve probar otro país
  }
  return null;
}

/**
 * Cotiza contra TODAS las transportadoras habilitadas en paralelo, y selecciona
 * automáticamente la ganadora: menor precio; en caso de empate, menor tiempo de entrega.
 * Devuelve { winner, allQuotes } — winner es null si ninguna transportadora cotizó.
 */
async function quoteAllAndPickWinner(params) {
  const results = await Promise.all(CARRIERS.map(c => quoteOne(c, params)));
  const validQuotes = results.filter(Boolean);

  if (!validQuotes.length) {
    return { winner: null, allQuotes: [] };
  }

  validQuotes.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price; // menor precio primero
    return a.deliveryDays - b.deliveryDays; // empate -> menor tiempo de entrega
  });

  return { winner: validQuotes[0], allQuotes: validQuotes };
}

/**
 * Crea el envío real en Mi Paquete (POST /createSending) usando la transportadora
 * ganadora ya seleccionada. orden debe incluir: order_num, name, phone, email,
 * address, total_cop, destiny_dane_code.
 *
 * paymentType 101 = prepago (requiere saldo disponible en la cuenta Mi Paquete;
 * si no hay saldo, la guía NO se genera). No usamos 102 (contraentrega) porque
 * el pago ya se cobró previamente al cliente vía Wompi.
 */
async function crearEnvio(orden, carrierId) {
  const nameParts = (orden.name || '').trim().split(' ');
  const receiverName = nameParts[0] || orden.name || 'Cliente';
  const receiverSurname = nameParts.slice(1).join(' ') || '.';

  const accountUserId = await getAccountUserId();
  if (!accountUserId) {
    throw new Error('No se pudo determinar el "user" de la cuenta Mi Paquete a partir del token — revisa MI_PAQUETE_EMAIL/MI_PAQUETE_PASSWORD');
  }

  // orden.items debe ser un array [{cat, qty}] (guardado como JSON en la columna
  // 'items' de la orden) — si no está disponible, se usa el paquete genérico.
  let cartItems = [];
  try {
    cartItems = typeof orden.items === 'string' ? JSON.parse(orden.items) : (orden.items || []);
  } catch (e) { /* deja cartItems vacío */ }
  const pkg = calculatePackageForCart(cartItems);

  // Mismos parámetros que se usaron al cotizar: valor declarado = valor de los PRODUCTOS (sin el envío),
  // así el seguro, y por tanto el flete, no cambian entre la cotización y la guía.
  const itemsSubtotal = cartItems.reduce((a, it) => a + (Number(it.subtotal) || 0), 0);
  const productsValue = itemsSubtotal || Math.max(0, (Number(orden.total_cop) || 0) - (Number(orden.shipping_price) || 0));
  const np = normalizeParams({ ...pkg, quantity: 1, declaredValue: productsValue });

  const payload = {
    adminTransactionData: { saleValue: 0 },
    channel: 'FlexFK Web',
    comments: `Pedido ${orden.order_num}`,
    description: `Pedido ${orden.order_num}`,
    criteria: 'price',
    deliveryCompany: carrierId,
    locate: {
      destinyDaneCode: toLocationCode(orden.destiny_dane_code),
      originDaneCode: toLocationCode(MP_ORIGIN_DANE_CODE),
      originCountryCode: workingCountry || COUNTRY_CODES[0],
      destinyCountryCode: workingCountry || COUNTRY_CODES[0]
    },
    paymentType: 101,
    productInformation: {
      declaredValue: np.declaredValue,
      forbiddenProduct: false,
      height: np.height,
      large: np.length,
      productReference: `Pedido ${orden.order_num}`,
      quantity: 1,
      weight: np.weight,
      width: np.width
    },
    receiver: {
      cellPhone: (orden.phone || '').replace(/\D/g, '').slice(-10) || '3000000000',
      destinationAddress: orden.address || '',
      email: orden.email || '',
      name: receiverName,
      nit: '.',
      nitType: '.',
      prefix: '+57',
      surname: receiverSurname
    },
    requestPickup: 'false',
    sender: {
      cellPhone: MP_SENDER_PHONE,
      email: MP_SENDER_EMAIL,
      name: MP_SENDER_NAME,
      nit: MP_SENDER_NIT,
      nitType: MP_SENDER_NIT_TYPE,
      pickupAddress: MP_SENDER_ADDRESS,
      prefix: '+57',
      surname: MP_SENDER_SURNAME
    },
    user: accountUserId
  };

  return withAuth(async (token) => {
    const { data } = await axios.post(`${MI_PAQUETE_BASE}/createSending`, payload, {
      headers: mpHeaders(token),
      timeout: 15000
    });
    return data;
  });
}

/**
 * Consulta el tracking de una guía ya creada (GET /getSendingTracking?mpCode=...).
 * mpCode es el identificador de la GUÍA en Mi Paquete — se usa solo para esta
 * consulta puntual, nunca como identificador del pedido en el resto del sistema.
 */
async function getTracking(mpCode) {
  return withAuth(async (token) => {
    const { data } = await axios.get(`${MI_PAQUETE_BASE}/getSendingTracking`, {
      params: { mpCode },
      headers: mpHeaders(token),
      timeout: 10000
    });
    return data;
  });
}

/** Consulta el listado de envíos generados (GET /getSendings), útil para diagnóstico. */
async function getSendings(queryParams) {
  return withAuth(async (token) => {
    const { data } = await axios.get(`${MI_PAQUETE_BASE}/getSendings`, {
      params: queryParams || {},
      headers: mpHeaders(token),
      timeout: 10000
    });
    return data;
  });
}

/** Cancela una guía existente (POST /cancelSending). Solo funciona si aún no fue
 *  recogida por la transportadora. */
async function cancelSending(mpCode) {
  return withAuth(async (token) => {
    const { data } = await axios.post(`${MI_PAQUETE_BASE}/cancelSending`, { mpCode }, {
      headers: mpHeaders(token),
      timeout: 10000
    });
    return data;
  });
}

module.exports = {
  CARRIERS,
  COUNTRY_CODES,
  MIN_DECLARED_VALUE,
  PACKAGE_BY_CATEGORY,
  resolveItemPackage,
  calculatePackageForCart,
  normalizeParams,
  extractQuote,
  toLocationCode,
  rawQuote,
  quoteOne,
  quoteAllAndPickWinner,
  crearEnvio,
  getTracking,
  getSendings,
  cancelSending
};
