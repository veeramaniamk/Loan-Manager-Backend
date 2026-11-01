const { verifyToken } = require('../utils/jwt');
const { verifyCsrfToken } = require('../utils/csrf');
const { logSecurityFailure } = require('./logger');
const { pool } = require('../config/db');

/**
 * Multi-layer security pipeline:
 * 1. Session Validation
 * 2. Cookie Validation
 * 3. CSRF Token Validation
 * 4. JWT Authorization & Authentication
 * 5. Session-JWT Identity Cross-check
 * 6. User Status Validation
 *
 * Any failure logs the full request details into `security_logs` table.
 */
async function validatePipeline(req, res, next) {
  // Attempt fallback session retrieval if req.session is empty but sid provided
  if (!req.session || !req.session.userId) {
    const rawSid = req.headers['x-session-id'] || req.cookies?.['connect.sid'];
    if (rawSid) {
      const sid = String(rawSid).startsWith('s:') ? String(rawSid).slice(2).split('.')[0] : String(rawSid);
      try {
        const { sessionStore } = require('../server');
        if (sessionStore && sessionStore.get) {
          const sessData = await sessionStore.get(sid);
          if (sessData && sessData.userId) {
            req.session = Object.assign(req.session || {}, sessData);
            req.sessionID = sid;
          }
        }
      } catch (e) {}
    }
  }

  // 1. Session Validation
  if (!req.session || !req.session.userId) {
    const errorMsg = 'Session validation failed: No active or valid session found. Please login.';
    const resPayload = { success: false, error: errorMsg, failedStage: 'SESSION_VALIDATION' };
    await logSecurityFailure(req, res, 401, errorMsg, resPayload);
    return res.status(401).json(resPayload);
  }

  // 2. Cookie Validation
  // Check for presence of cookies (either cookie-parser parsed req.cookies or raw Cookie header or x-session-id)
  const hasCookies = (req.cookies && Object.keys(req.cookies).length > 0) || 
                     Boolean(req.headers.cookie) || 
                     Boolean(req.headers['x-session-id']);
  if (!hasCookies) {
    const errorMsg = 'Cookie validation failed: Required authentication cookies were not provided with the request.';
    const resPayload = { success: false, error: errorMsg, failedStage: 'COOKIE_VALIDATION' };
    await logSecurityFailure(req, res, 401, errorMsg, resPayload);
    return res.status(401).json(resPayload);
  }

  // 3. CSRF Token Validation
  // Extract CSRF token from common headers or body
  const csrfToken = req.headers['x-csrf-token'] || 
                    req.headers['x-xsrf-token'] || 
                    req.headers['csrf-token'] || 
                    req.body?._csrf;

  if (!csrfToken) {
    const errorMsg = 'CSRF validation failed: Missing X-CSRF-Token header in request.';
    const resPayload = { success: false, error: errorMsg, failedStage: 'CSRF_VALIDATION' };
    await logSecurityFailure(req, res, 403, errorMsg, resPayload);
    return res.status(403).json(resPayload);
  }

  const sessionCsrf = req.session.csrfToken;
  const isCsrfValid = verifyCsrfToken(csrfToken, sessionCsrf);
  if (!isCsrfValid) {
    const errorMsg = 'CSRF validation failed: Provided CSRF token is invalid, expired, or untrusted.';
    const resPayload = { success: false, error: errorMsg, failedStage: 'CSRF_VALIDATION' };
    await logSecurityFailure(req, res, 403, errorMsg, resPayload);
    return res.status(403).json(resPayload);
  }

  // 4. JWT Validation
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies?.jwt_token) {
    token = req.cookies.jwt_token;
  } else if (req.headers['x-access-token']) {
    token = req.headers['x-access-token'];
  }

  if (!token) {
    const errorMsg = 'JWT validation failed: Bearer token is missing from Authorization header.';
    const resPayload = { success: false, error: errorMsg, failedStage: 'JWT_VALIDATION' };
    await logSecurityFailure(req, res, 401, errorMsg, resPayload);
    return res.status(401).json(resPayload);
  }

  const jwtResult = verifyToken(token);
  if (!jwtResult.valid) {
    const errorMsg = `JWT validation failed: ${jwtResult.error || 'Token expired or invalid signature'}.`;
    const resPayload = { success: false, error: errorMsg, failedStage: 'JWT_VALIDATION' };
    await logSecurityFailure(req, res, 401, errorMsg, resPayload);
    return res.status(401).json(resPayload);
  }

  // 5. Cross-Check Session User ID vs JWT User ID
  const decodedUser = jwtResult.decoded;
  if (String(decodedUser.id) !== String(req.session.userId)) {
    const errorMsg = `Cross-validation mismatch: Session User ID (${req.session.userId}) does not match JWT User ID (${decodedUser.id}).`;
    const resPayload = { success: false, error: errorMsg, failedStage: 'IDENTITY_CROSS_CHECK' };
    await logSecurityFailure(req, res, 403, errorMsg, resPayload);
    return res.status(403).json(resPayload);
  }

  // 6. Database Verification: Check user is still active
  try {
    const [rows] = await pool.query(
      'SELECT id, username, email, full_name, role, status FROM users WHERE id = ?',
      [decodedUser.id]
    );

    if (rows.length === 0) {
      const errorMsg = 'Account validation failed: User account no longer exists.';
      const resPayload = { success: false, error: errorMsg, failedStage: 'USER_LOOKUP' };
      await logSecurityFailure(req, res, 401, errorMsg, resPayload);
      return res.status(401).json(resPayload);
    }

    const user = rows[0];
    if (user.status !== 'active') {
      const errorMsg = 'Account validation failed: User account is inactive or disabled.';
      const resPayload = { success: false, error: errorMsg, failedStage: 'USER_INACTIVE' };
      await logSecurityFailure(req, res, 403, errorMsg, resPayload);
      return res.status(403).json(resPayload);
    }

    // Attach active user context to request
    req.user = user;
    next();
  } catch (dbErr) {
    console.error('Database error during auth validation:', dbErr);
    const errorMsg = 'Internal server error verifying credentials.';
    const resPayload = { success: false, error: errorMsg, failedStage: 'DB_ERROR' };
    await logSecurityFailure(req, res, 500, errorMsg, resPayload);
    return res.status(500).json(resPayload);
  }
}

/**
 * Admin role restriction middleware
 */
async function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    const errorMsg = 'Access Denied: Administrative privileges are required for this action.';
    const resPayload = { success: false, error: errorMsg, failedStage: 'ROLE_AUTHORIZATION' };
    await logSecurityFailure(req, res, 403, errorMsg, resPayload);
    return res.status(403).json(resPayload);
  }
  next();
}

module.exports = {
  validatePipeline,
  requireAdmin
};
