const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const dotenv = require('dotenv');
const { pool, initDatabase } = require('./config/db');
const { logSecurityFailure } = require('./middleware/logger');

// Load environment variables
dotenv.config({ override: true });

const app = express();
const PORT = process.env.PORT || 5000;

// Trust first proxy (useful for reverse proxies and getting real IPs)
app.set('trust proxy', 1);

// 1. CORS Configuration - Crucial for both Angular Web and Android clients
const allowedOrigins = [
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost:')) {
      return callback(null, true);
    }
    // For local development flexibility
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'x-csrf-token',
    'x-xsrf-token',
    'csrf-token',
    'x-client-platform',
    'x-client-type',
    'x-session-id',
    'Cookie'
  ],
  exposedHeaders: ['Set-Cookie', 'x-csrf-token', 'x-session-id'],
  maxAge: 86400
}));

// 2. Cookie Parser
app.use(cookieParser());

// 3. Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 4. Session Store using MySQL
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000, // 15 mins
  expiration: 86400000, // 1 day
  createDatabaseTable: false,
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data'
    }
  }
}, pool);

app.use(session({
  key: 'connect.sid',
  secret: process.env.SESSION_SECRET || 'loan_manager_super_secure_session_secret_key_2026_xyz!@#',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: false, // Set to false so client / mobile can read or retain
    secure: false, // development localhost
    sameSite: 'lax'
  }
}));

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Loan Manager Backend API'
  });
});

// Mount Application Routes
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/loans', require('./routes/loans.routes'));
app.use('/api/people', require('./routes/people.routes'));
app.use('/api/admin', require('./routes/admin.routes'));

// Fallback for undefined routes: Log failure and return 404
app.use(async (req, res) => {
  const errorMsg = `Endpoint not found: ${req.method} ${req.originalUrl}`;
  const responsePayload = { success: false, error: errorMsg, failedStage: 'ROUTE_NOT_FOUND' };
  await logSecurityFailure(req, res, 404, errorMsg, responsePayload);
  res.status(404).json(responsePayload);
});

// Global Error Handler
app.use(async (err, req, res, next) => {
  console.error('Unhandled server error:', err);
  const errorMsg = err.message || 'Internal Server Error';
  const responsePayload = { success: false, error: errorMsg, failedStage: 'INTERNAL_SERVER_ERROR' };
  await logSecurityFailure(req, res, 500, errorMsg, responsePayload);
  res.status(500).json(responsePayload);
});

// Start server
async function startServer() {
  try {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Loan Manager Backend server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

module.exports = { app, sessionStore };
