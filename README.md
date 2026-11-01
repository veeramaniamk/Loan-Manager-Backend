# Loan Manager Backend (Node.js & MySQL)

Production-ready Node.js Express backend featuring a multi-layered security validation pipeline:
- **Session Validation**: MySQL persistent sessions via `express-mysql-session` (`loan_sessions`).
- **Cookie Validation**: Enforces authentication cookie presence.
- **CSRF Token Validation**: Cryptographic double-submit / session-backed CSRF protection.
- **JWT Authorization**: Signed bearer token with expiration.
- **Cross-Identity Verification**: Session User ID must match JWT User ID.
- **Security Audit Failure Logging**: Any failed attempt logs HTTP request parameters, body, sanitized headers, response, and exact failure reason into MySQL `loan_security_logs`.
- **Android App Support**: Seamlessly accepts CookieJar session cookies and headers for Android clients.

## Configuration
Database credentials and server settings are located in `.env`:
- `DB_HOST=localhost`
- `DB_USER=root`
- `DB_PASSWORD=12345`
- `DB_NAME=loan_manager_db`
- `PORT=5000`

## Start Server
```bash
npm start
# or development with auto-reload:
npm run dev
```

## Default Accounts
- **Administrator**: `admin` / `admin123`
- **Standard User**: `veera` / `veera123`
