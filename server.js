/**
 * server.js — Servidor estático + cron de sincronización diaria con SQL
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { syncOsData } = require('./sync_os');
const { syncNetSuite } = require('./sync_netsuite');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.pdf':  'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Portal escuchando en puerto ${PORT}`);
  syncOsData();
  syncNetSuite();
});

// Cron diario 7:00 AM hora México (13:00 UTC)
cron.schedule('0 13 * * *', () => {
  console.log('[cron] Ejecutando sincronización diaria...');
  syncOsData();
  syncNetSuite();
});
