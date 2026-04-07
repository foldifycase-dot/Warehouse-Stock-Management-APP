const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;
const API_VERSION = '2024-01';

const shopifyHeaders = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json',
};

// ─── Allowed origins (add your Vercel warehouse URL once deployed) ───────────
const ALLOWED_ORIGINS = [
  'https://foldifycase-warehouse.vercel.app',
  'http://localhost:3000',
];

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { service, action } = req.query;

  try {
    // ── SHOPIFY ────────────────────────────────────────────────────────────
    if (service === 'shopify') {

      // Products — with tags for warehouse filtering
      if (action === 'products') {
        const limit = req.query.limit || 250;
        const url = `https://${STORE}/admin/api/${API_VERSION}/products.json?limit=${limit}&fields=id,title,tags,variants,images`;
        const r = await fetch(url, { headers: shopifyHeaders });
        const d = await r.json();
        return res.status(200).json(d);
      }

      // Orders — last N days, for 90-day sales ranking
      if (action === 'orders') {
        const days = parseInt(req.query.days) || 90;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const limit = req.query.limit || 250;
        const url = `https://${STORE}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${since}&limit=${limit}&fields=id,created_at,line_items`;
        const r = await fetch(url, { headers: shopifyHeaders });
        const d = await r.json();
        return res.status(200).json(d);
      }

      // Locations — to identify warehouse vs dropship locations
      if (action === 'locations') {
        const url = `https://${STORE}/admin/api/${API_VERSION}/locations.json`;
        const r = await fetch(url, { headers: shopifyHeaders });
        const d = await r.json();
        return res.status(200).json(d);
      }

      return res.status(400).json({ error: `Unknown shopify action: ${action}` });
    }

    // ── EMAIL ALERTS via Resend ────────────────────────────────────────────
    if (service === 'alert') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { to, from_name, from_email, subject, type, warehouse, products } = body;

      if (!to || !to.length) {
        return res.status(400).json({ error: 'No recipients provided' });
      }
      if (!RESEND_KEY) {
        return res.status(500).json({ error: 'RESEND_API_KEY not configured in Vercel env vars' });
      }

      const html = buildEmailHTML({ type, warehouse, products, from_name });

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${from_name || 'FoldifyCase Warehouse'} <${from_email || 'alerts@foldifycase.com'}>`,
          to: Array.isArray(to) ? to : [to],
          subject: subject || `FoldifyCase Stock Alert — ${warehouse}`,
          html,
        }),
      });

      const result = await r.json();
      if (!r.ok) {
        return res.status(r.status).json({ error: result.message || 'Resend error', detail: result });
      }
      return res.status(200).json({ success: true, id: result.id });
    }

    return res.status(400).json({ error: `Unknown service: ${service}` });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Email HTML builder ────────────────────────────────────────────────────
function buildEmailHTML({ type, warehouse, products, from_name }) {
  const critical = products.filter(p => p.status === 'critical');
  const low = products.filter(p => p.status === 'low');
  const now = new Date().toLocaleString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const productRow = (p, urgency) => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #f0ede4;font-size:13px;color:#1a1a1a;max-width:280px">${p.title}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f0ede4;font-size:13px;color:#1a1a1a;text-align:center;font-weight:600">${p.qty}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f0ede4;text-align:center">
        <span style="display:inline-block;padding:2px 10px;border-radius:4px;font-size:11px;font-weight:600;background:${urgency === 'critical' ? '#FCEBEB' : '#FAEEDA'};color:${urgency === 'critical' ? '#791F1F' : '#633806'}">
          ${urgency === 'critical' ? 'Critical' : 'Low'}
        </span>
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid #f0ede4;font-size:12px;color:#666;text-align:center">${Math.max(50 - p.qty, 10)} units</td>
    </tr>`;

  const tableHeader = `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e8e4d9;border-radius:8px;overflow:hidden;margin-bottom:24px">
      <thead>
        <tr style="background:#F5F3E9">
          <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:left">Product</th>
          <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:center">Units left</th>
          <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:center">Status</th>
          <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:center">Suggested order</th>
        </tr>
      </thead>
      <tbody>`;

  let tableBody = '';
  if (type === 'critical') {
    tableBody = critical.map(p => productRow(p, 'critical')).join('');
  } else if (type === 'low') {
    tableBody = [
      ...critical.map(p => productRow(p, 'critical')),
      ...low.map(p => productRow(p, 'low')),
    ].join('');
  } else {
    tableBody = products.map(p => productRow(p, p.status)).join('');
  }

  if (!tableBody) {
    tableBody = `<tr><td colspan="4" style="padding:20px;text-align:center;color:#888;font-size:13px">No products match this alert type.</td></tr>`;
  }

  const alertCount = type === 'critical' ? critical.length : type === 'low' ? critical.length + low.length : products.length;
  const alertLabel = type === 'critical' ? `${critical.length} critical` : type === 'low' ? `${critical.length} critical, ${low.length} low` : `${products.length} products`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3e9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:620px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e4d9">

    <!-- Header -->
    <div style="background:#111;padding:24px 32px;display:flex;align-items:center;gap:14px">
      <div style="width:36px;height:36px;background:#fff;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h14l-2 4H7L5 4z" fill="#111"/><path d="M7 10h10l-2 4H9l-2-4z" fill="#111"/><path d="M9 16h6l-3 4-3-4z" fill="#111"/></svg>
      </div>
      <div>
        <div style="color:#fff;font-size:15px;font-weight:600">FoldifyCase Warehouse</div>
        <div style="color:#888;font-size:12px;margin-top:2px">Stock alert — ${warehouse}</div>
      </div>
    </div>

    <!-- Alert banner -->
    <div style="background:${critical.length > 0 ? '#FAEEDA' : '#EAF3DE'};border-bottom:1px solid ${critical.length > 0 ? '#FAC775' : '#C0DD97'};padding:14px 32px;font-size:13px;color:${critical.length > 0 ? '#633806' : '#27500A'}">
      <strong>${alertCount > 0 ? alertLabel : 'Stock report'}</strong> at ${warehouse} requires attention · ${now}
    </div>

    <!-- Body -->
    <div style="padding:28px 32px">
      <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6">
        Hi team, here is your ${type === 'full' ? 'full stock report' : 'stock alert'} for <strong>${warehouse}</strong>.
        Please review and action the reorder suggestions below.
      </p>

      ${tableHeader}${tableBody}</tbody></table>

      <p style="margin:0;font-size:12px;color:#aaa;text-align:center;line-height:1.6">
        Sent by FoldifyCase Warehouse Manager · ${from_name || 'FoldifyCase'}<br>
        To change alert settings, open the warehouse app.
      </p>
    </div>
  </div>
</body>
</html>`;
}
