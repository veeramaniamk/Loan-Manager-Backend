const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { generateToken } = require('../utils/jwt');
const { generateCsrfToken } = require('../utils/csrf');
const { validatePipeline } = require('../middleware/auth');
const { logSecurityFailure } = require('../middleware/logger');

/**
 * @route   GET /api/auth/csrf
 * @desc    Obtain CSRF token and set XSRF-TOKEN cookie
 * @access  Public
 */
router.get('/csrf', (req, res) => {
  const csrfToken = generateCsrfToken();
  req.session.csrfToken = csrfToken;

  // Set XSRF-TOKEN cookie (accessible to client for sending in x-csrf-token header)
  res.cookie('XSRF-TOKEN', csrfToken, {
    path: '/',
    sameSite: 'lax',
    secure: false, // Set to true if HTTPS
    httpOnly: false
  });

  return res.json({
    success: true,
    csrfToken
  });
});

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user, initialize session, set cookies & issue JWT
 * @access  Public
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    const errorMsg = 'Please provide both username and password.';
    const resPayload = { success: false, error: errorMsg };
    await logSecurityFailure(req, res, 400, errorMsg, resPayload);
    return res.status(400).json(resPayload);
  }

  try {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, username]
    );

    if (rows.length === 0) {
      const errorMsg = 'Invalid username or password.';
      const resPayload = { success: false, error: errorMsg };
      await logSecurityFailure(req, res, 401, errorMsg, resPayload);
      return res.status(401).json(resPayload);
    }

    const user = rows[0];

    if (user.status !== 'active') {
      const errorMsg = 'Your account has been deactivated. Contact an administrator.';
      const resPayload = { success: false, error: errorMsg };
      await logSecurityFailure(req, res, 403, errorMsg, resPayload);
      return res.status(403).json(resPayload);
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      const errorMsg = 'Invalid username or password.';
      const resPayload = { success: false, error: errorMsg };
      await logSecurityFailure(req, res, 401, errorMsg, resPayload);
      return res.status(401).json(resPayload);
    }

    // 1. Establish Session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    const csrfToken = generateCsrfToken();
    req.session.csrfToken = csrfToken;

    // 2. Generate JWT
    const token = generateToken({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    });

    // 3. Set Cookies
    const cookieOptions = {
      path: '/',
      sameSite: 'lax',
      secure: false, // development localhost
      maxAge: 24 * 60 * 60 * 1000
    };

    res.cookie('jwt_token', token, { ...cookieOptions, httpOnly: true });
    res.cookie('XSRF-TOKEN', csrfToken, { ...cookieOptions, httpOnly: false });
    res.cookie('session_active', 'true', { ...cookieOptions, httpOnly: false });

    // Explicitly save session before returning response
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
      }

      return res.json({
        success: true,
        message: 'Authentication successful',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          full_name: user.full_name,
          role: user.role
        },
        token,
        csrfToken,
        sessionId: req.sessionID
      });
    });

  } catch (err) {
    console.error('Login error:', err);
    const errorMsg = 'Internal server error during login.';
    const resPayload = { success: false, error: errorMsg };
    await logSecurityFailure(req, res, 500, errorMsg, resPayload);
    return res.status(500).json(resPayload);
  }
});

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user account
 * @access  Public
 */
router.post('/register', async (req, res) => {
  const { username, email, password, full_name } = req.body;

  if (!username || !email || !password || !full_name) {
    const errorMsg = 'All fields (username, email, password, full_name) are required.';
    const resPayload = { success: false, error: errorMsg };
    await logSecurityFailure(req, res, 400, errorMsg, resPayload);
    return res.status(400).json(resPayload);
  }

  try {
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );

    if (existing.length > 0) {
      const errorMsg = 'Username or email already exists.';
      const resPayload = { success: false, error: errorMsg };
      await logSecurityFailure(req, res, 409, errorMsg, resPayload);
      return res.status(409).json(resPayload);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(`
      INSERT INTO users (username, email, password_hash, full_name, role, status)
      VALUES (?, ?, ?, ?, 'user', 'active')
    `, [username, email, passwordHash, full_name]);

    return res.status(201).json({
      success: true,
      message: 'Account registered successfully. You can now log in.',
      userId: result.insertId
    });
  } catch (err) {
    console.error('Registration error:', err);
    const errorMsg = 'Failed to register user.';
    const resPayload = { success: false, error: errorMsg };
    await logSecurityFailure(req, res, 500, errorMsg, resPayload);
    return res.status(500).json(resPayload);
  }
});

/**
 * @route   POST /api/auth/logout
 * @desc    Destroy session and clear auth cookies
 * @access  Public (or protected)
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    res.clearCookie('connect.sid', { path: '/' });
    res.clearCookie('jwt_token', { path: '/' });
    res.clearCookie('XSRF-TOKEN', { path: '/' });
    res.clearCookie('session_active', { path: '/' });
    return res.json({ success: true, message: 'Logged out successfully' });
  });
});

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile (Validates session, cookie, csrf, jwt pipeline)
 * @access  Protected
 */
router.get('/me', validatePipeline, (req, res) => {
  return res.json({
    success: true,
    user: req.user
  });
});

module.exports = router;
