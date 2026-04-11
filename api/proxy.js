const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const API_VERSION = '2024-01';
const PO_BLOB_KEY = 'History of restock/po_orders.json';

const shopifyHeaders = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json',
};

const ALLOWED_ORIGINS = [
  'https://warehouse-stock-management-app.vercel.app',
  'http://localhost:3000',
];

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { service, action } = req.query;

  try {

    // ── SHOPIFY ──────────────────────────────────────────────────────────────
    if (service === 'shopify') {

      if (action === 'products') {
        const limit = req.query.limit || 250;
        const url = `https://${STORE}/admin/api/${API_VERSION}/products.json?limit=${limit}&fields=id,title,handle,tags,variants,images,image`;
        const r = await fetch(url, { headers: shopifyHeaders });
        const d = await r.json();
        return res.status(200).json(d);
      }

      if (action === 'orders') {
        const days = parseInt(req.query.days) || 90;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const limit = req.query.limit || 250;
        const url = `https://${STORE}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${since}&limit=${limit}&fields=id,created_at,line_items`;
        const r = await fetch(url, { headers: shopifyHeaders });
        const d = await r.json();
        return res.status(200).json(d);
      }

      if (action === 'locations') {
        const url = `https://${STORE}/admin/api/${API_VERSION}/locations.json`;
        const r = await fetch(url, { headers: shopifyHeaders });
        const d = await r.json();
        return res.status(200).json(d);
      }

      if (action === 'inventory_levels') {
        // Fetch inventory levels for given location IDs
        // Returns all variant inventory across those locations
        const locationIds = req.query.location_ids || '';
        if (!locationIds) return res.status(400).json({ error: 'location_ids required' });

        // Shopify limits to 250 per page — paginate if needed
        let allLevels = [];
        let pageUrl = `https://${STORE}/admin/api/${API_VERSION}/inventory_levels.json?location_ids=${locationIds}&limit=250`;

        // Fetch up to 10 pages (2500 inventory records)
        for (let page = 0; page < 10; page++) {
          const r = await fetch(pageUrl, { headers: shopifyHeaders });
          const d = await r.json();
          const levels = d.inventory_levels || [];
          allLevels = allLevels.concat(levels);

          // Check for next page via Link header
          const linkHeader = r.headers.get('link') || '';
          const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          if (!nextMatch || levels.length < 250) break;
          pageUrl = nextMatch[1];
        }

        return res.status(200).json({ inventory_levels: allLevels });
      }

      // Set inventory quantity at a specific location
      if (action === 'set_inventory') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { inventory_item_id, location_id, available } = body;
        if (!inventory_item_id || !location_id || available === undefined) {
          return res.status(400).json({ error: 'inventory_item_id, location_id, available required' });
        }
        const r = await fetch(`https://${STORE}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
          method: 'POST',
          headers: shopifyHeaders,
          body: JSON.stringify({ inventory_item_id, location_id, available: parseInt(available) })
        });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: d.errors || 'Shopify error', detail: d });
        return res.status(200).json({ success: true, inventory_level: d.inventory_level });
      }

      // Get inventory item ID for a variant (needed to set inventory)
      if (action === 'inventory_item') {
        const variantId = req.query.variant_id;
        if (!variantId) return res.status(400).json({ error: 'variant_id required' });
        const r = await fetch(`https://${STORE}/admin/api/${API_VERSION}/variants/${variantId}.json?fields=id,inventory_item_id`, { headers: shopifyHeaders });
        const d = await r.json();
        return res.status(200).json(d);
      }

      return res.status(400).json({ error: `Unknown shopify action: ${action}` });
    }

    // ── EMAIL via Resend ─────────────────────────────────────────────────────
    if (service === 'alert') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST required' });
      }

      // Parse body — handle both string and object, and large payloads
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {
          return res.status(400).json({ error: 'Invalid JSON body' });
        }
      }
      if (!body) {
        return res.status(400).json({ error: 'Empty request body' });
      }

      const { to, from_name, from_email, subject, type, warehouse, products } = body;

      if (!to || !to.length) {
        return res.status(400).json({ error: 'No recipients provided' });
      }
      if (!RESEND_KEY) {
        return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
      }

      // Use custom_html if provided (supplier PO emails), otherwise build stock alert html
      const html = body.custom_html
        ? body.custom_html
        : buildEmailHTML({ type, warehouse, products, from_name });

      const fromAddress = `${from_name || 'FoldifyCase Warehouse'} <${from_email || 'warehouse@foldifycase.com.au'}>`;
      const emailSubject = subject || `FoldifyCase Stock Alert — ${warehouse}`;

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddress,
          to: Array.isArray(to) ? to : [to],
          subject: emailSubject,
          html,
        }),
      });

      const result = await resendRes.json();

      if (!resendRes.ok) {
        console.error('Resend error:', result);
        return res.status(resendRes.status).json({
          error: result.message || result.name || 'Resend rejected the request',
          detail: result,
        });
      }

      return res.status(200).json({ success: true, id: result.id });
    }

    // ── BLOB: save/load PO order history ────────────────────────────────────
    if (service === 'blob') {

      if (action === 'save_po') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { orders } = body;
        if (!Array.isArray(orders)) return res.status(400).json({ error: 'orders array required' });
        if (!BLOB_TOKEN) return res.status(500).json({ error: 'BLOB_TOKEN not configured' });

        // PUT to Vercel Blob REST API
        // addRandomSuffix=0 keeps filename stable, allowOverwrite=1 replaces existing file
        const encodedKey = PO_BLOB_KEY.split('/').map(encodeURIComponent).join('/');
        const putUrl = `https://blob.vercel-storage.com/${encodedKey}?addRandomSuffix=0&allowOverwrite=1`;
        console.log('[save_po] Writing to:', putUrl);
        const r = await fetch(putUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${BLOB_TOKEN}`,
            'Content-Type': 'application/json',
            'x-api-version': '7',
          },
          body: JSON.stringify(orders),
        });
        const responseText = await r.text();
        console.log('[save_po] Status:', r.status, 'Response:', responseText.slice(0, 200));
        if (!r.ok) {
          return res.status(r.status).json({ error: 'Blob write failed', detail: responseText });
        }
        let d = {};
        try { d = JSON.parse(responseText); } catch(e) {}
        console.log('[save_po] Saved to:', d.url);
        return res.status(200).json({ success: true, url: d.url });
      }

      if (action === 'load_po') {
        if (!BLOB_TOKEN) return res.status(500).json({ error: 'BLOB_TOKEN not configured' });

        // Fetch directly using known public store URL + file path
        const BLOB_BASE = 'https://srtpdbjltmzvyywy.public.blob.vercel-storage.com';
        const fileUrl = `${BLOB_BASE}/${PO_BLOB_KEY.replace(/ /g, '%20')}`;
        console.log('[load_po] Fetching:', fileUrl);

        const r = await fetch(fileUrl + '?t=' + Date.now()); // cache-bust
        console.log('[load_po] Response status:', r.status);

        // 404 = file doesn't exist yet (no orders placed)
        if (r.status === 404) {
          console.log('[load_po] No orders file yet — returning empty array');
          return res.status(200).json({ orders: [] });
        }
        if (!r.ok) {
          const err = await r.text();
          console.error('[load_po] Fetch failed:', r.status, err);
          return res.status(200).json({ orders: [], error: 'fetch failed: ' + r.status });
        }

        const orders = await r.json();
        console.log('[load_po] Loaded', Array.isArray(orders) ? orders.length : '?', 'orders');
        return res.status(200).json({ orders: Array.isArray(orders) ? orders : [] });
      }

      return res.status(400).json({ error: `Unknown blob action: ${action}` });
    }

    return res.status(400).json({ error: `Unknown service: ${service}` });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Stock alert email builder ─────────────────────────────────────────────────
function buildEmailHTML({ type, warehouse, products, from_name }) {
  const critical = (products || []).filter(p => p.status === 'critical');
  const low = (products || []).filter(p => p.status === 'low');
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
      <td style="padding:10px 16px;border-bottom:1px solid #f0ede4;font-size:12px;color:#666;text-align:center">${Math.max(50 - (p.qty || 0), 10)} units</td>
    </tr>`;

  let tableBody = '';
  if (type === 'critical') {
    tableBody = critical.map(p => productRow(p, 'critical')).join('');
  } else if (type === 'low') {
    tableBody = [
      ...critical.map(p => productRow(p, 'critical')),
      ...low.map(p => productRow(p, 'low')),
    ].join('');
  } else {
    tableBody = (products || []).map(p => productRow(p, p.status)).join('');
  }

  if (!tableBody) {
    tableBody = `<tr><td colspan="4" style="padding:20px;text-align:center;color:#888;font-size:13px">No products match this alert type.</td></tr>`;
  }

  const alertCount = type === 'critical'
    ? critical.length
    : type === 'low'
    ? critical.length + low.length
    : (products || []).length;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3e9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:620px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e4d9">
    <div style="background:#111;padding:24px 32px">
      <div style="color:#fff;font-size:15px;font-weight:600">FoldifyCase Warehouse</div>
      <div style="color:#888;font-size:12px;margin-top:2px">Stock alert — ${warehouse || ''}</div>
    </div>
    <div style="background:${critical.length > 0 ? '#FAEEDA' : '#EAF3DE'};border-bottom:1px solid ${critical.length > 0 ? '#FAC775' : '#C0DD97'};padding:14px 32px;font-size:13px;color:${critical.length > 0 ? '#633806' : '#27500A'}">
      <strong>${alertCount} product${alertCount !== 1 ? 's' : ''}</strong> at ${warehouse || ''} require attention
    </div>
    <div style="padding:28px 32px">
      <table width="100%" style="border-collapse:collapse;border:1px solid #e8e4d9;border-radius:8px;overflow:hidden;margin-bottom:20px">
        <thead>
          <tr style="background:#F5F3E9">
            <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:left">Product</th>
            <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:center">Units</th>
            <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:center">Status</th>
            <th style="padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;text-align:center">Suggest order</th>
          </tr>
        </thead>
        <tbody>${tableBody}</tbody>
      </table>
      <p style="margin:0;font-size:12px;color:#aaa;text-align:center">
        Sent by FoldifyCase Warehouse Manager · ${from_name || 'FoldifyCase'}
      </p>
    </div>
  </div>
</body>
</html>`;
}
