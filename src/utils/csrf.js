const crypto = require('crypto');

const CSRF_SECRET = process.env.CSRF_SECRET || 'loan_manager_csrf_secret_salt_456789!';

/**
 * Generate a new CSRF token associated with an optional secret or random seed
 */
function generateCsrfToken() {
  const randomBytes = crypto.randomBytes(24).toString('hex');
  const timestamp = Date.now().toString(36);
  const signature = crypto.createHmac('sha256', CSRF_SECRET)
    .update(`${randomBytes}:${timestamp}`)
    .digest('hex');
  return `${randomBytes}.${timestamp}.${signature}`;
}

/**
 * Validate that a CSRF token has valid signature and matches session/cookie
 */
function verifyCsrfToken(token, expectedToken = null) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  // If comparing directly to expectedToken stored in session or cookie
  if (expectedToken && token === expectedToken) {
    return true;
  }

  // Verify HMAC signature to prevent tampering
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [randomBytes, timestamp, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', CSRF_SECRET)
    .update(`${randomBytes}:${timestamp}`)
    .digest('hex');

  // Constant time comparison
  try {
    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
    if (!isSignatureValid) return false;

    // Check token age (e.g. valid for 48 hours)
    const tokenTime = parseInt(timestamp, 36);
    const now = Date.now();
    if (isNaN(tokenTime) || now - tokenTime > 48 * 60 * 60 * 1000) {
      return false;
    }

    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  generateCsrfToken,
  verifyCsrfToken
};
