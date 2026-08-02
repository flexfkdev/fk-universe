// netlify/functions/lib/email.js
// Módulo reutilizable de envío de correos transaccionales vía Resend.
// Usa la API REST directa de Resend (sin el SDK oficial) para no agregar una
// dependencia nueva al proyecto — ya usamos axios en todo el resto del backend.
'use strict';

const axios = require('axios');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Flex FK <pedidos@flexfk.com>';
const SITIO_WEB_URL = process.env.SITIO_WEB_URL || '';

const BRAND = {
  red: '#e81c1c',
  bg: '#080808',
  surface: '#111111',
  text: '#f0f0f0',
  muted: '#8a8a8a'
};

const STATUS_LABELS = {
  pending: { label: 'Pedido recibido', emoji: '🕓', color: BRAND.muted },
  quoted: { label: 'Cotizando envío', emoji: '📦', color: BRAND.muted },
  created: { label: 'Guía generada', emoji: '📦', color: BRAND.red },
  in_transit: { label: 'En camino', emoji: '🚚', color: BRAND.red },
  delivered: { label: 'Entregado', emoji: '✅', color: '#3a8a3a' },
  failed: { label: 'Problema con el envío', emoji: '⚠️', color: BRAND.red },
  cancelled: { label: 'Cancelado', emoji: '✕', color: BRAND.muted }
};

/**
 * Genera el HTML del correo de pedido/envío con la identidad visual de Flex FK.
 * Diseñado con tablas (compatibilidad máxima con clientes de correo) y estilos
 * inline, siguiendo las buenas prácticas estándar para email HTML.
 */
function buildOrderEmailHtml({ orderNum, name, statusKey, carrierName, trackingNumber, orderUrl, logoUrl }) {
  const status = STATUS_LABELS[statusKey] || STATUS_LABELS.pending;
  const firstName = (name || '').trim().split(' ')[0] || 'Hola';

  const headerContent = logoUrl
    ? `<img src="${logoUrl}" alt="Flex FK" height="34" style="height:34px;max-height:34px;object-fit:contain;display:inline-block;">`
    : `<div style="font-family:Arial Black,Arial,sans-serif;font-size:28px;letter-spacing:6px;color:${BRAND.red};font-weight:900;">FLEX FK</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flex FK — Pedido ${orderNum}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bg};font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background-color:${BRAND.surface};border:1px solid #1e1e1e;">

          <!-- Header -->
          <tr>
            <td style="padding:32px 32px 20px;text-align:center;border-bottom:1px solid #1e1e1e;">
              ${headerContent}
            </td>
          </tr>

          <!-- Status badge -->
          <tr>
            <td style="padding:32px 32px 8px;text-align:center;">
              <div style="font-size:36px;line-height:1;margin-bottom:8px;">${status.emoji}</div>
              <div style="font-size:20px;font-weight:700;color:${status.color};letter-spacing:1px;text-transform:uppercase;">${status.label}</div>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:8px 32px 24px;text-align:center;color:${BRAND.text};font-size:14px;line-height:1.6;">
              Hola ${firstName}, este es el estado actual de tu pedido en Flex FK.
            </td>
          </tr>

          <!-- Order details box -->
          <tr>
            <td style="padding:0 32px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;border:1px solid #1e1e1e;">
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #1a1a1a;">
                    <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.muted};margin-bottom:4px;">Número de pedido</div>
                    <div style="font-size:18px;font-weight:700;color:${BRAND.text};letter-spacing:1px;">${orderNum}</div>
                  </td>
                </tr>
                ${carrierName ? `
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #1a1a1a;">
                    <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.muted};margin-bottom:4px;">Transportadora</div>
                    <div style="font-size:15px;color:${BRAND.text};">${carrierName}</div>
                  </td>
                </tr>` : ''}
                ${trackingNumber ? `
                <tr>
                  <td style="padding:16px 20px;">
                    <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.muted};margin-bottom:4px;">Número de guía</div>
                    <div style="font-size:15px;color:${BRAND.red};font-weight:700;letter-spacing:1px;">${trackingNumber}</div>
                  </td>
                </tr>` : ''}
              </table>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td style="padding:0 32px 32px;text-align:center;">
              <a href="${orderUrl}" target="_blank" style="display:inline-block;background-color:${BRAND.red};color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:14px 32px;">Ver mi pedido</a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px 32px;border-top:1px solid #1a1a1a;text-align:center;">
              <div style="font-size:11px;color:#333333;letter-spacing:1px;">© Flex FK. Todos los derechos reservados.</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Obtiene la URL del logo configurado en site_config (mismo lugar donde el
 * panel admin del sitio lo guarda). Si falla o no hay logo, devuelve null y
 * el correo cae en el fallback de texto "FLEX FK".
 */
async function fetchSiteLogoUrl() {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SB_KEY) return null;
  try {
    const { data } = await axios.get(`${SB_URL}/rest/v1/site_config`, {
      params: { key: 'eq.logo', select: 'value' },
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      timeout: 5000
    });
    return (data && data[0] && data[0].value) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Envía el correo de estado de pedido/envío al comprador vía Resend.
 * No lanza excepción si falla — el flujo de negocio (pago/envío) no debe romperse
 * porque el correo no salió; el error se devuelve para que el caller decida loguearlo.
 */
async function sendOrderStatusEmail({ to, orderNum, name, statusKey, carrierName, trackingNumber }) {
  if (!RESEND_API_KEY) {
    return { ok: false, error: 'Falta configurar RESEND_API_KEY' };
  }
  if (!to) {
    return { ok: false, error: 'Falta el email del destinatario' };
  }

  const orderUrl = `${SITIO_WEB_URL}/orders/${orderNum}`;
  const status = STATUS_LABELS[statusKey] || STATUS_LABELS.pending;
  const logoUrl = await fetchSiteLogoUrl();
  const html = buildOrderEmailHtml({ orderNum, name, statusKey, carrierName, trackingNumber, orderUrl, logoUrl });

  try {
    const { data } = await axios.post('https://api.resend.com/emails', {
      from: RESEND_FROM,
      to: [to],
      subject: `Flex FK — Pedido ${orderNum}: ${status.label}`,
      html
    }, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    return { ok: true, id: data && data.id };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('Error enviando email vía Resend:', detail);
    return { ok: false, error: detail };
  }
}

module.exports = { sendOrderStatusEmail, buildOrderEmailHtml, STATUS_LABELS };
