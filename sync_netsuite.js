/**
 * sync_netsuite.js — Sincronización diaria NetSuite → Firebase
 * Obtiene refacciones instaladas por OS del reporte cr=2738
 * Parser HTML propio (sin dependencias externas) para evitar ERR_REQUIRE_ESM
 */
const https = require('https');

const NS_ACCOUNT  = process.env.NS_ACCOUNT  || '5848805';
const NS_EMAIL    = process.env.NS_EMAIL    || '';
const NS_ROLE     = process.env.NS_ROLE     || '1202';
const NS_ENTITY   = process.env.NS_ENTITY   || '29719';
const NS_HASH     = process.env.NS_HASH     || 'AAEJ7tMQxHAjE3NhT3uQbIM2Q_jVjZGa3QC7vKcpa3ZzqcXGDDw';
const NS_CR       = process.env.NS_CR       || '2738';

const FIREBASE_URL    = 'https://portal-auditoria-rational-default-rtdb.firebaseio.com/v1/os_netsuite.json';
const FIREBASE_KEPLER = 'https://portal-auditoria-rational-default-rtdb.firebaseio.com/v1/os_kepler.json?shallow=true';

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

// Parser HTML simple — extrae filas de la primera tabla sin dependencias externas
function parseNetSuiteTable(html) {
  const decodeHtml = s => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .trim();

  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  const rows = [];
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    const rowHtml = rowMatch[1];
    const cellReLocal = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    while ((cellMatch = cellReLocal.exec(rowHtml)) !== null) {
      // Quitar tags internos, decodificar entidades
      const text = decodeHtml(cellMatch[1].replace(/<[^>]+>/g, ''));
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

async function syncNetSuite() {
  if (!NS_EMAIL) {
    console.warn('[sync_ns] NS_EMAIL no configurado — omitiendo sync NetSuite');
    return;
  }
  const start = Date.now();
  console.log(`[sync_ns] Iniciando sincronización NetSuite ${new Date().toISOString()}`);

  try {
    const webQueryUrl = `https://${NS_ACCOUNT}.app.netsuite.com/app/reporting/webquery.nl` +
      `?compid=${NS_ACCOUNT}&entity=${NS_ENTITY}&email=${encodeURIComponent(NS_EMAIL)}&role=${NS_ROLE}&cr=${NS_CR}&hash=${NS_HASH}`;

    const res = await fetchUrl(webQueryUrl);

    if (res.status !== 200) {
      console.error(`[sync_ns] HTTP ${res.status} — verifica NS_EMAIL y NS_HASH`);
      return;
    }

    const rows = parseNetSuiteTable(res.body);
    if (rows.length < 2) {
      console.warn('[sync_ns] Sin filas en la respuesta NetSuite (filas:', rows.length, ')');
      console.warn('[sync_ns] Primeros 500 chars del body:', res.body.substring(0, 500));
      return;
    }

    const headers = rows[0].map(h => h.toLowerCase());
    console.log(`[sync_ns] ${rows.length - 1} filas · columnas: ${headers.join(', ')}`);

    // Columnas exactas del reporte NetSuite cr=2738
    const osCol   = headers.findIndex(h => h === 'os kepler' || h === 'os (serv industrial)' || h === 'os' || h.includes('orden') || h.includes('order'));
    const partCol = headers.findIndex(h => h === 'artículo' || h === 'articulo' || h.includes('part') || h.includes('refacc') || h.includes('item'));
    const descCol = headers.findIndex(h => h === 'descripción' || h === 'descripcion' || (h.includes('desc') && !h.includes('estado')));
    const qtyCol  = headers.findIndex(h => h === 'cantidad' || h.includes('qty') || h.includes('quantity'));
    const costCol = headers.findIndex(h => h === 'importe' || h.includes('cost') || h.includes('costo') || h.includes('amount'));

    console.log(`[sync_ns] Columnas → os:${osCol}(${headers[osCol]}), part:${partCol}(${headers[partCol]}), desc:${descCol}, qty:${qtyCol}, cost:${costCol}`);

    const osMap = {};
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rawOS = osCol >= 0 ? String(row[osCol] || '').trim() : '';
      if (!rawOS) continue;
      const osKey = rawOS.replace(/^0+/, '') || rawOS;

      if (!osMap[osKey]) osMap[osKey] = { refacciones: [], costoTotal: 0 };

      const part = partCol >= 0 ? String(row[partCol] || '').trim() : '';
      const desc = descCol >= 0 ? String(row[descCol] || '').trim() : '';
      const qty  = qtyCol  >= 0 ? parseFloat(String(row[qtyCol] || '0').replace(/[^0-9.]/g, '')) || 0 : 0;
      const cost = costCol >= 0 ? parseFloat(String(row[costCol] || '0').replace(/[^0-9.]/g, '')) || 0 : 0;

      if (part || desc) {
        osMap[osKey].refacciones.push({ part, desc, qty, cost });
        osMap[osKey].costoTotal += cost;
      }
    }

    for (const k of Object.keys(osMap)) {
      osMap[k].costoTotal = Math.round(osMap[k].costoTotal * 100) / 100;
    }

    // Filtrar solo OS que existen en os_kepler (RATIONAL) para no exceder límite Firebase
    let keplerKeys = null;
    try {
      const kr = await fetchUrl(FIREBASE_KEPLER);
      if (kr.status === 200) keplerKeys = new Set(Object.keys(JSON.parse(kr.body)));
    } catch(e) { console.warn('[sync_ns] No se pudo obtener os_kepler keys:', e.message); }

    const filtered = {};
    for (const k of Object.keys(osMap)) {
      if (!keplerKeys || keplerKeys.has(k)) filtered[k] = osMap[k];
    }
    const count = Object.keys(filtered).length;
    console.log(`[sync_ns] Filtrando a OS RATIONAL: ${count} de ${Object.keys(osMap).length}`);

    filtered._syncedAt = new Date().toISOString();
    const putRes = await firebasePut(filtered);
    console.log(`[sync_ns] Firebase PUT response (primeros 100): ${String(putRes).substring(0, 100)}`);
    console.log(`[sync_ns] ✅ Firebase actualizado · ${count} OS con refacciones · ${((Date.now()-start)/1000).toFixed(1)}s`);

  } catch (err) {
    console.error('[sync_ns] ❌ Error:', err.message);
  }
}

module.exports = { syncNetSuite };
