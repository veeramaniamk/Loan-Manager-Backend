const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'loan_manager_jwt_access_secret_token_987654321_abc$%^';

function generateToken(payload, expiresIn = '24h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    return { valid: true, decoded: jwt.verify(token, JWT_SECRET) };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  generateToken,
  verifyToken,
  JWT_SECRET
};
