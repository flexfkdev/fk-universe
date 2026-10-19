// netlify/functions/lib/mipaquete-auth.js
// Autenticación dinámica contra Mi Paquete. El "apikey" no es una credencial fija:
// se obtiene haciendo login (email + password) contra POST /generateapikey, y esa
// key se reutiliza (no expira en cada request, según su propia documentación) —
// pero por robustez, si en algún request Mi Paquete la rechaza (401), este módulo
// automáticamente pide una nueva y reintenta una vez.
//
// Mejoras sobre la versión anterior:
//  - El token se guarda también en memoria: ya no se consulta Supabase en cada llamada
//    (la cotización lanza 5 llamadas en paralelo, una por transportadora).
//  - Renovación "de a una": si varias llamadas reciben 401 a la vez, solo se hace UN login nuevo.
//  - Si el token es un JWT con fecha de expiración vencida, se renueva antes de usarlo.
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MI_PAQUETE_BASE = process.env.MI_PAQUETE_BASE || 'https://api-v2.mpr.mipaquete.com';
// .trim() por seguridad: es muy común que al copiar/pegar una credencial en el
// panel de Netlify quede un espacio o salto de línea invisible al final, lo cual
// rompe la comparación exacta del lado de Mi Paquete sin que se note a simple vista.
const MI_PAQUETE_EMAIL = (process.env.MI_PAQUETE_EMAIL || '').trim();
const MI_PAQUETE_PASSWORD = (process.env.MI_PAQUETE_PASSWORD || '').trim();

let memToken = null;        // token en memoria (por instancia de la función)
let refreshing = null;      // promesa de renovación en curso (evita logins duplicados)

/**
 * Decodifica el PAYLOAD de un JWT sin verificar su firma (no hace falta: el token
 * ya nos lo entregó Mi Paquete directamente por HTTPS, solo leemos los datos que
 * contiene). Un JWT tiene 3 partes separadas por ".": header.payload.signature.
 */
function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(payloadB64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

/** true si el token es un JWT con "exp" y ya venció (o vence en menos de 60 s). */
function isExpired(token) {
  const p = decodeJwtPayload(token);
  return !!(p && p.exp && p.exp * 1000 < Date.now() + 60 * 1000);
}

/**
 * Devuelve el "_id" de la cuenta autenticada, extraído directamente del token vigente.
 * Este es el mismo valor que la API espera en el campo "user" de /createSending —
 * no hace falta pedirlo ni configurarlo aparte, ya viene incluido en el apikey.
 */
async function getAccountUserId() {
  const token = await getToken();
  const payload = decodeJwtPayload(token);
  return payload && payload._id ? payload._id : null;
}

/** Lee el token guardado en Supabase (tabla mipaquete_auth, fila única id=1). */
async function getStoredToken() {
  const { data, error } = await supabase
    .from('mipaquete_auth')
    .select('token')
    .eq('id', 1)
    .single();
  if (error || !data) return null;
  return data.token;
}

/** Guarda/actualiza el token vigente en Supabase. */
async function storeToken(token) {
  await supabase
    .from('mipaquete_auth')
    .upsert([{ id: 1, token, updated_at: new Date().toISOString() }]);
}

/** Hace login contra Mi Paquete y devuelve un token nuevo (no lo guarda por sí solo). */
async function loginAndGetFreshToken() {
  if (!MI_PAQUETE_EMAIL || !MI_PAQUETE_PASSWORD) {
    throw new Error('Faltan MI_PAQUETE_EMAIL / MI_PAQUETE_PASSWORD en las variables de entorno');
  }

  // Log de diagnóstico SEGURO: nunca imprime la contraseña real, solo su longitud
  // y si el email/password tienen aspecto razonable. Útil para descartar espacios
  // invisibles o valores vacíos sin exponer ninguna credencial en los logs.
  console.log('Intentando login en Mi Paquete:', {
    emailLength: MI_PAQUETE_EMAIL.length,
    emailLooksValid: MI_PAQUETE_EMAIL.includes('@'),
    passwordLength: MI_PAQUETE_PASSWORD.length,
    base: MI_PAQUETE_BASE
  });

  try {
    const { data } = await axios.post(`${MI_PAQUETE_BASE}/generateapikey`, {
      email: MI_PAQUETE_EMAIL,
      password: MI_PAQUETE_PASSWORD
    }, {
      headers: {
        'session-tracker': crypto.randomUUID(),
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    if (!data || !data.APIKey) {
      throw new Error('generateapikey no devolvió un APIKey válido');
    }
    return data.APIKey;
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('Login en Mi Paquete falló:', detail);
    throw err;
  }
}

/** Renueva el token UNA sola vez aunque lo pidan varias llamadas a la vez. */
function refreshToken() {
  if (!refreshing) {
    refreshing = (async () => {
      const fresh = await loginAndGetFreshToken();
      memToken = fresh;
      await storeToken(fresh);
      return fresh;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Devuelve un token vigente: memoria → Supabase → login nuevo. */
async function getToken() {
  if (memToken && !isExpired(memToken)) return memToken;
  if (refreshing) return refreshing;
  const stored = await getStoredToken();
  if (stored && !isExpired(stored)) {
    memToken = stored;
    return stored;
  }
  return refreshToken();
}

/**
 * Ejecuta una función que hace una llamada a Mi Paquete, inyectándole el token vigente.
 * Si la llamada falla con 401, renueva el token una vez y reintenta automáticamente.
 * `requestFn` recibe (token) y debe devolver la promesa de axios.
 */
async function withAuth(requestFn) {
  let token = await getToken();
  try {
    return await requestFn(token);
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 401) {
      console.warn('Token de Mi Paquete rechazado (401) — renovando y reintentando...');
      // Si otra llamada ya renovó el token mientras tanto, se usa ese en vez de hacer otro login
      token = (memToken && memToken !== token) ? memToken : await refreshToken();
      return await requestFn(token);
    }
    throw err;
  }
}

module.exports = { getToken, refreshToken, withAuth, getAccountUserId, decodeJwtPayload };
