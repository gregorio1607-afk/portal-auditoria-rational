/**
 * sync_netsuite.js — Sincronización diaria NetSuite → Firebase
 * Obtiene refacciones instaladas por OS del reporte guardado cr=2738
 */
const https = require('https');
const { parse } = require('node-html-parser');

const NS_ACCOUNT  = process.env.NS_ACCOUNT  || '5848805';
const NS_EMAIL    = process.env.NS_EMAIL    || '';
const NS_PASSWORD = process.env.NS_PASSWORD || '';
const NS_ROLE     = process.env.NS_ROLE     || '1202';
const NS_ENTITY   = process.env.NS_ENTITY   || '29719';
const NS_HASH     = process.env.NS_HASH     || 'AAEJ7tMQxHAjE3NhT3uQbIM2Q_jVjZGa3QC7vKcpa3ZzqcXGDDw';
const NS_CR       = process.env.NS_CR       || '2738';

const FIREBASE_URL = 'https://portal-auditoria-rational-default-rtdb.firebaseio.com/v1/os_netsuite.json';

function fetchUrl(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'text/html,application/xhtml+xml', ...headers },
    };
    let data = '';
    const req = https.request(opts, res => {
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function firebasePut(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(FIREBASE_URL);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function parseNetSuiteTable(html) {
  // NetSuite devuelve una tabla HTML con los resultados
  const root = parse(html);
  const rows = root.querySelectorAll('table tr');
  if (!rows.length) return [];

  // Primera fila = encabezados
  const headers = rows[0].querySelectorAll('th,td').map(td => td.text.trim().toLowerCase());
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].querySelectorAll('td');
    if (!cells.length) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] ? cells[idx].text.trim() : ''); });
    result.push(obj);
  }
  return result;
}

async function syncNetSuite() {
  if (!NS_EMAIL || !NS_PASSWORD) {
    console.warn('[sync_ns] NS_EMAIL o NS_PASSWORD no configurados — omitiendo sync NetSuite');
    return;
  }
  const start = Date.now();
  console.log(`[sync_ns] Iniciando sincronización NetSuite ${new Date().toISOString()}`);

  try {
    // Intentar con webquery.nl usando hash (sin password)
    const webQueryUrl = `https://${NS_ACCOUNT}.app.netsuite.com/app/reporting/webquery.nl` +
      `?compid=${NS_ACCOUNT}&entity=${NS_ENTITY}&email=${encodeURIComponent(NS_EMAIL)}&role=${NS_ROLE}&cr=${NS_CR}&hash=${NS_HASH}`;

    let res = await fetchUrl(webQueryUrl);

    // Si falla (requiere auth), usar NLAuth
    if (res.status !== 200 || !res.body.includes('<table')) {
      console.log('[sync_ns] webquery sin hash fallido, intentando NLAuth...');
      const nlAuth = `NLAuth nlauth_account=${NS_ACCOUNT}, nlauth_email=${NS_EMAIL}, nlauth_signature=${NS_PASSWORD}, nlauth_role=${NS_ROLE}`;
      res = await fetchUrl(webQueryUrl, { Authorization: nlAuth });
    }

    if (res.status !== 200) {
      console.error(`[sync_ns] HTTP ${res.status} — verifica credenciales NS_EMAIL y NS_PASSWORD`);
      return;
    }

    const tableRows = parseNetSuiteTable(res.body);
    if (!tableRows.length) {
      console.warn('[sync_ns] Sin filas en la respuesta NetSuite');
      return;
    }

    console.log(`[sync_ns] ${tableRows.length} filas obtenidas de NetSuite`);
    console.log('[sync_ns] Columnas:', Object.keys(tableRows[0]).join(', '));

    // Agrupar por OS — buscar columna que contenga "os" o "orden"
    const osMap = {};
    const headers = Object.keys(tableRows[0]);
    const osCol   = headers.find(h => h === 'os' || h.includes('orden') || h.includes('order') || h.includes('work order') || h === 'caso');
    const partCol = headers.find(h => h.includes('part') || h.includes('refacc') || h.includes('articulo') || h.includes('item') || h.includes('parte'));
    const descCol = headers.find(h => h.includes('desc') || h.includes('nombre') || h.includes('name'));
    const qtyCol  = headers.find(h => h.includes('qty') || h.includes('cant') || h.includes('quantity'));
    const costCol = headers.find(h => h.includes('cost') || h.includes('costo') || h.includes('amount') || h.includes('importe') || h.includes('total'));

    console.log(`[sync_ns] Columnas mapeadas → os:${osCol}, part:${partCol}, desc:${descCol}, qty:${qtyCol}, cost:${costCol}`);

    for (const row of tableRows) {
      const rawOS = osCol ? String(row[osCol] || '').trim() : '';
      if (!rawOS) continue;
      const osKey = rawOS.replace(/^0+/, '') || rawOS;

      if (!osMap[osKey]) osMap[osKey] = { refacciones: [], costoTotal: 0 };

      const part = partCol ? String(row[partCol] || '').trim() : '';
      const desc = descCol ? String(row[descCol] || '').trim() : '';
      const qty  = qtyCol  ? parseFloat(String(row[qtyCol] || '0').replace(/[^0-9.]/g, '')) || 0 : 0;
      const cost = costCol ? parseFloat(String(row[costCol] || '0').replace(/[^0-9.]/g, '')) || 0 : 0;

      if (part || desc) {
        osMap[osKey].refacciones.push({ part, desc, qty, cost });
        osMap[osKey].costoTotal += cost;
      }
    }

    // Redondear costos
    for (const k of Object.keys(osMap)) {
      osMap[k].costoTotal = Math.round(osMap[k].costoTotal * 100) / 100;
    }

    osMap._syncedAt = new Date().toISOString();
    await firebasePut(osMap);
    console.log(`[sync_ns] ✅ Firebase actualizado · ${Object.keys(osMap).length} OS con refacciones · ${((Date.now()-start)/1000).toFixed(1)}s`);

  } catch (err) {
    console.error('[sync_ns] ❌ Error:', err.message);
  }
}

module.exports = { syncNetSuite };
