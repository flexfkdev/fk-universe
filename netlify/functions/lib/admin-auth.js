// netlify/functions/lib/admin-auth.js
// Verifica en el SERVIDOR que quien llama es el admin: valida el token de sesión de Supabase
// (login con Google) y compara el email con ADMIN_EMAIL.
'use strict';

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'booking.flex.mc@gmail.com').toLowerCase();

async function requireAdmin(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  return !error && !!data && !!data.user && String(data.user.email || '').toLowerCase() === ADMIN_EMAIL;
}

module.exports = { requireAdmin };
