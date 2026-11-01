const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config({ override: true });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '12345',
  database: 'loan_manager_db',
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  decimalNumbers: true
});

async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    console.log(' Connected to MySQL database:', process.env.DB_NAME || 'loan_manager_db');

    // Auto-migrate legacy table names if they exist
    const [existingTables] = await connection.query('SHOW TABLES');
    const tableList = existingTables.map(t => Object.values(t)[0]);

    const tableMigrations = [
      ['users', 'loan_users'],
      ['people', 'loan_people'],
      ['loans', 'loan_loans'],
      ['security_logs', 'loan_security_logs'],
      ['sessions', 'loan_sessions']
    ];

    for (const [oldName, newName] of tableMigrations) {
      if (tableList.includes(oldName) && !tableList.includes(newName)) {
        console.log(` Migrating table '${oldName}' to '${newName}'...`);
        await connection.query(`RENAME TABLE \`${oldName}\` TO \`${newName}\``);
      }
    }

    // Create tables if not exist
    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
        status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_people (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(25) NULL,
        email VARCHAR(100) NULL,
        location VARCHAR(150) NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_people_user (user_id),
        CONSTRAINT fk_people_user FOREIGN KEY (user_id) REFERENCES loan_users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_loans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        person_id INT NOT NULL,
        type ENUM('given', 'taken') NOT NULL COMMENT 'given = I gave (receivable), taken = I took (payable)',
        principal_amount DECIMAL(12, 2) NOT NULL,
        interest_rate DECIMAL(5, 2) DEFAULT 0.00,
        issue_date DATE NOT NULL,
        due_date DATE NULL,
        location VARCHAR(150) NULL,
        status ENUM('pending', 'partially_paid', 'settled', 'overdue') NOT NULL DEFAULT 'pending',
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_loans_user (user_id),
        INDEX idx_loans_person (person_id),
        INDEX idx_loans_due_date (due_date),
        INDEX idx_loans_status (status),
        CONSTRAINT fk_loans_user FOREIGN KEY (user_id) REFERENCES loan_users(id) ON DELETE CASCADE,
        CONSTRAINT fk_loans_person FOREIGN KEY (person_id) REFERENCES loan_people(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        loan_id INT NOT NULL,
        user_id INT NOT NULL,
        payment_date DATE NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        payment_method ENUM('cash', 'upi', 'bank_transfer', 'cheque', 'other') DEFAULT 'cash',
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_payments_loan (loan_id),
        INDEX idx_payments_user (user_id),
        INDEX idx_payments_date (payment_date),
        CONSTRAINT fk_payments_loan FOREIGN KEY (loan_id) REFERENCES loan_loans(id) ON DELETE CASCADE,
        CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES loan_users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_security_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        ip_address VARCHAR(60) NULL,
        user_agent TEXT NULL,
        client_type VARCHAR(50) NULL,
        method VARCHAR(10) NOT NULL,
        url TEXT NOT NULL,
        route VARCHAR(255) NULL,
        headers LONGTEXT NULL,
        params LONGTEXT NULL,
        query LONGTEXT NULL,
        body LONGTEXT NULL,
        status_code INT NOT NULL,
        failure_reason TEXT NOT NULL,
        response_body LONGTEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_logs_created_at (created_at),
        INDEX idx_logs_status (status_code),
        INDEX idx_logs_user (user_id)
      ) ENGINE=InnoDB;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS loan_sessions (
        session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
        expires INT(11) UNSIGNED NOT NULL,
        data MEDIUMTEXT COLLATE utf8mb4_bin,
        PRIMARY KEY (session_id)
      ) ENGINE=InnoDB;
    `);

    // Seed default admin and user if not exists
    const [adminRows] = await connection.query('SELECT id FROM loan_users WHERE username = ?', ['admin']);
    let adminId;
    if (adminRows.length === 0) {
      const adminPasswordHash = await bcrypt.hash('admin123', 10);
      const [res] = await connection.query(`
        INSERT INTO loan_users (username, email, password_hash, full_name, role, status)
        VALUES (?, ?, ?, ?, 'admin', 'active')
      `, ['admin', 'admin@loanmanager.com', adminPasswordHash, 'System Administrator']);
      adminId = res.insertId;
      console.log(' Seeded default admin: username=admin, password=admin123');
    } else {
      adminId = adminRows[0].id;
    }

    const [userRows] = await connection.query('SELECT id FROM loan_users WHERE username = ?', ['veera']);
    let userId;
    if (userRows.length === 0) {
      const userPasswordHash = await bcrypt.hash('veera123', 10);
      const [res] = await connection.query(`
        INSERT INTO loan_users (username, email, password_hash, full_name, role, status)
        VALUES (?, ?, ?, ?, 'user', 'active')
      `, ['veera', 'veera@loanmanager.com', userPasswordHash, 'Veeramuthu']);
      userId = res.insertId;
      console.log(' Seeded default user: username=veera, password=veera123');
    } else {
      userId = userRows[0].id;
    }

    // Seed sample people & loans for testing if empty
    const [personCount] = await connection.query('SELECT COUNT(*) as count FROM loan_people WHERE user_id = ?', [userId]);
    if (personCount[0].count === 0) {
      const [p1] = await connection.query(`
        INSERT INTO loan_people (user_id, name, phone, email, location, notes)
        VALUES (?, 'Karthik Raja', '+91 9876543210', 'karthik@gmail.com', 'Chennai, T. Nagar', 'Colleague from office')
      `, [userId]);
      const [p2] = await connection.query(`
        INSERT INTO loan_people (user_id, name, phone, email, location, notes)
        VALUES (?, 'Priya Sundaram', '+91 9845123456', 'priya@gmail.com', 'Coimbatore, Gandhipuram', 'College friend')
      `, [userId]);
      const [p3] = await connection.query(`
        INSERT INTO loan_people (user_id, name, phone, email, location, notes)
        VALUES (?, 'Ramesh Kumar', '+91 9789123456', 'ramesh@gmail.com', 'Madurai, Anna Nagar', 'Neighbor / Business vendor')
      `, [userId]);

      const today = new Date().toISOString().slice(0, 10);
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const pastDue = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

      // Loan given to Karthik (Pending receivable)
      const [l1] = await connection.query(`
        INSERT INTO loan_loans (user_id, person_id, type, principal_amount, interest_rate, issue_date, due_date, location, status, notes)
        VALUES (?, ?, 'given', 25000.00, 0, ?, ?, 'Chennai, T. Nagar', 'pending', 'Emergency medical help lent')
      `, [userId, p1.insertId, today, nextWeek]);

      // Loan given to Priya (Partially paid)
      const [l2] = await connection.query(`
        INSERT INTO loan_loans (user_id, person_id, type, principal_amount, interest_rate, issue_date, due_date, location, status, notes)
        VALUES (?, ?, 'given', 50000.00, 2, '2026-10-15', ?, 'Coimbatore, Gandhipuram', 'partially_paid', 'Equipment purchase loan')
      `, [userId, p2.insertId, pastDue]);

      // Payment for l2 (Priya repaid 15000 today)
      await connection.query(`
        INSERT INTO loan_payments (loan_id, user_id, payment_date, amount, payment_method, notes)
        VALUES (?, ?, ?, 15000.00, 'upi', 'First partial settlement via GPay')
      `, [l2.insertId, userId, today]);

      // Loan taken from Ramesh (Payable - I owe him)
      await connection.query(`
        INSERT INTO loan_loans (user_id, person_id, type, principal_amount, interest_rate, issue_date, due_date, location, status, notes)
        VALUES (?, ?, 'taken', 18000.00, 0, '2026-10-20', ?, 'Madurai, Anna Nagar', 'pending', 'Borrowed for vehicle servicing')
      `, [userId, p3.insertId, nextWeek]);

      console.log(' Seeded initial realistic sample loans, people, and today payments');
    }

    connection.release();
  } catch (err) {
    console.error('❌ Error initializing MySQL database:', err);
    throw err;
  }
}

module.exports = {
  pool,
  initDatabase
};
