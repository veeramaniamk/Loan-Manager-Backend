const { pool } = require('../config/db');

function maskSensitiveData(data) {
  if (!data || typeof data !== 'object') return data;
  const masked = Array.isArray(data) ? [...data] : { ...data };
  const sensitiveKeys = ['password', 'password_hash', 'confirmPassword', 'secret', 'authorization'];

  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      masked[key] = '***MASKED***';
    } else if (typeof masked[key] === 'object' && masked[key] !== null) {
      masked[key] = maskSensitiveData(masked[key]);
    }
  }
  return masked;
}

function detectClientType(req) {
  const customHeader = req.headers['x-client-platform'] || req.headers['x-client-type'];
  if (customHeader) return String(customHeader);

  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('android')) return 'Android App';
  if (ua.includes('okhttp') || ua.includes('retrofit') || ua.includes('dalvik')) return 'Android OkHttp/Client';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS App';
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari')) return 'Web Browser';
  if (ua.includes('postman')) return 'Postman';
  return 'Unknown / Custom Client';
}

async function logSecurityFailure(req, res, statusCode, failureReason, responseBody = {}) {
  try {
    const userId = req.user?.id || req.session?.userId || null;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const clientType = detectClientType(req);
    const method = req.method;
    const url = req.originalUrl || req.url;
    const route = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;

    // Mask headers
    const sanitizedHeaders = maskSensitiveData({ ...req.headers });
    // Mask body
    const sanitizedBody = maskSensitiveData(req.body || {});

    const queryStr = JSON.stringify(req.query || {});
    const paramsStr = JSON.stringify(req.params || {});
    const headersStr = JSON.stringify(sanitizedHeaders);
    const bodyStr = JSON.stringify(sanitizedBody);
    const responseStr = JSON.stringify(responseBody);

    await pool.query(`
      INSERT INTO security_logs 
      (user_id, ip_address, user_agent, client_type, method, url, route, headers, params, query, body, status_code, failure_reason, response_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      ipAddress,
      userAgent,
      clientType,
      method,
      url,
      route,
      headersStr,
      paramsStr,
      queryStr,
      bodyStr,
      statusCode,
      failureReason,
      responseStr
    ]);

    console.warn(`[SECURITY FAILURE] [${clientType}] ${method} ${url} -> Status ${statusCode}: ${failureReason}`);
  } catch (err) {
    console.error('Failed to write security failure to database:', err);
  }
}

module.exports = {
  logSecurityFailure,
  maskSensitiveData,
  detectClientType
};
