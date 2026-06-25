/**
 * sync_os.js — Sincronización diaria SQL Server → Firebase
 * Ejecutado desde server.js vía node-cron
 */
const sql = require('mssql');
const https = require('https');

const SQL_CONFIG = {
  server: 'CONSULTAS.DDNS.NET',
  port: 1434,
  user: 'CONSULTAS',
  password: 'SERVINDUSTRIAL',
  database: 'ServIndustrial',
  options: { trustServerCertificate: true, encrypt: false },
  requestTimeout: 120000,
  connectionTimeout: 30000,
};

const FIREBASE_URL = 'https://portal-auditoria-rational-default-rtdb.firebaseio.com/v1/os_kepler.json';

const QUERY = `
SELECT ZZZ.*,
ISNULL(CONVERT(CHAR(10),(SELECT TOP 1 H.C3 FROM GDOSHISTORIAL H WHERE H.C5=2 AND H.C1=ZZZ.OS ORDER BY H.C2),103),'') AS FECHA_1_PROG,
ISNULL(CONVERT(CHAR(10),(SELECT TOP 1 H.C3 FROM GDOSHISTORIAL H WHERE H.C5=2 AND H.C1=ZZZ.OS ORDER BY H.C2 DESC),103),'') AS FECHA_ULT_PROG,
ISNULL(CONVERT(CHAR(10),(SELECT TOP 1 H.C3 FROM GDOSHISTORIAL H WHERE H.C5=80 AND H.C1=ZZZ.OS ORDER BY H.C2 DESC),103),'') AS FECHA_ULT_REP_TERM,
(SELECT TOP 1 CAST(H.C6 AS VARCHAR(200))+CAST(H.C7 AS VARCHAR(200))+CAST(H.C8 AS VARCHAR(200))+CAST(H.C9 AS VARCHAR(200))+CAST(H.C10 AS VARCHAR(200))
 FROM GDOSHISTORIAL H WHERE H.C5 IN (6,80,3) AND LEN(H.C17)>0 AND H.C1=ZZZ.OS ORDER BY H.C2 DESC) AS ULT_REPORTE,
(SELECT IIF(T.C2='T3','SI','NO') FROM GDOSTAREREAL T WHERE T.C1=ZZZ.OS AND T.C2='T3') AS TI,
(SELECT IIF(T.C2='T10','SI','NO') FROM GDOSTAREREAL T WHERE T.C1=ZZZ.OS AND T.C2='T10') AS NEG_CLIENTE,
(SELECT IIF(T.C2='T13','SI','NO') FROM GDOSTAREREAL T WHERE T.C1=ZZZ.OS AND T.C2='T13') AS NEG_INTERNA,
(SELECT IIF(T.C2='T15','SI','NO') FROM GDOSTAREREAL T WHERE T.C1=ZZZ.OS AND T.C2='T15') AS DESGASTE,
(SELECT TOP 1 GTA.C2 FROM GDOSTAREREAL GTR LEFT JOIN GDOSTAREAS GTA ON GTA.C1=GTR.C2 WHERE GTR.C1=ZZZ.OS ORDER BY CAST(SUBSTRING(GTR.C2,2,4) AS INT)) AS TAREA
FROM (
  SELECT CONVERT(CHAR(10),GDOS.C5,103) AS FECHA, GDOS.C1 AS OS,
    GDOSTIPOSERV.C2 AS TIPO_SERV, GDOSSTATUS.C2 AS STATUS,
    KDUDP.C3 AS PROSP, ISNULL(KDMS.C2,'') AS SUCURSAL,
    ISNULL(KDIG.C2,'') AS MARCA, GDOS.C32 AS IM, GDOS.C13 AS FALLA,
    ISNULL(GDOSTECNICOS.C3,'') AS TECNICO,
    ISNULL(CONVERT(CHAR(10),GDOS.C33,103),'') AS FECHA_PROGRAMACION,
    GDOSSTATUS.C2 AS ESTATUS_EQ, KDIE.C2 AS MODELO,
    MAX(GDOSHISTORIAL.C3) AS _LAST_H
  FROM GDOS
  LEFT JOIN GDOSEXTRAS ON GDOSEXTRAS.C1=GDOS.C1
  LEFT JOIN KDMS ON GDOS.C14=KDMS.C1
  LEFT JOIN GDOSTECNICOS ON GDOS.C31=GDOSTECNICOS.C1
  LEFT JOIN GDOSHISTORIAL ON GDOS.C1=GDOSHISTORIAL.C1
  LEFT JOIN GDEQUIPOS ON GDEQUIPOS.C1=GDOS.C35
  LEFT JOIN GDOSSTATUS ON GDOS.C6=GDOSSTATUS.C1
  LEFT JOIN KDUDP ON GDOS.C3=KDUDP.C2
  LEFT JOIN KDIG ON GDOS.C10=KDIG.C1
  LEFT JOIN GDOSTIPOSERV ON GDOS.C2=GDOSTIPOSERV.C1
  LEFT JOIN KDIE ON KDIE.C1=GDEQUIPOS.C6
  WHERE GDOS.C1<>0 AND DATEPART(year,GDOS.C5)>='2025'
    AND KDIG.C2='RATIONAL'
  GROUP BY GDOS.C5,GDOS.C1,GDOSTIPOSERV.C2,GDOSSTATUS.C2,KDUDP.C3,KDMS.C2,
    KDIG.C2,GDOSTECNICOS.C3,GDOS.C32,GDOS.C13,GDEQUIPOS.C7,GDOS.C33,KDIE.C2
) ZZZ
ORDER BY OS
`;

function firebasePut(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(FIREBASE_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function syncOsData() {
  const start = Date.now();
  console.log(`[sync_os] Iniciando sincronización ${new Date().toISOString()}`);
  let pool;
  try {
    pool = await sql.connect(SQL_CONFIG);
    const result = await pool.request().query(QUERY);
    const rows = result.recordset;
    console.log(`[sync_os] ${rows.length} OS RATIONAL obtenidas de SQL`);

    // Convertir a objeto indexado por OS (sin ceros a la izquierda como clave)
    const osMap = {};
    for (const r of rows) {
      const key = String(r.OS || '').replace(/^0+/, '') || String(r.OS);
      osMap[key] = {
        fecha:      r.FECHA          || '',
        status:     r.STATUS         || '',
        prosp:      r.PROSP          || '',
        sucursal:   r.SUCURSAL       || '',
        marca:      r.MARCA          || '',
        falla:      r.FALLA          || '',
        tecnico:    r.TECNICO        || '',
        fechaProg:  r.FECHA_PROGRAMACION || '',
        fecha1Prog: r.FECHA_1_PROG   || '',
        fechaUltProg: r.FECHA_ULT_PROG || '',
        fechaUltRep: r.FECHA_ULT_REP_TERM || '',
        ultReporte: (r.ULT_REPORTE   || '').substring(0, 400),
        ti:         r.TI             || 'NO',
        negCliente: r.NEG_CLIENTE    || 'NO',
        negInterna: r.NEG_INTERNA    || 'NO',
        desgaste:   r.DESGASTE       || 'NO',
        tarea:      r.TAREA          || '',
        modelo:     r.MODELO         || '',
      };
    }

    osMap._syncedAt = new Date().toISOString();
    await firebasePut(osMap);
    console.log(`[sync_os] ✅ Firebase actualizado en ${((Date.now()-start)/1000).toFixed(1)}s`);
  } catch (err) {
    console.error('[sync_os] ❌ Error:', err.message);
  } finally {
    if (pool) await pool.close();
  }
}

module.exports = { syncOsData };
