-- Create database if not exists
CREATE DATABASE IF NOT EXISTS loan_manager_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE loan_manager_db;

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
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

-- 2. People Table (Borrowers / Lenders)
CREATE TABLE IF NOT EXISTS people (
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
  CONSTRAINT fk_people_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. Loans Table
CREATE TABLE IF NOT EXISTS loans (
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
  CONSTRAINT fk_loans_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_loans_person FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Loan Payments Table
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
  CONSTRAINT fk_payments_loan FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Security & Request Failure Logs Table
CREATE TABLE IF NOT EXISTS security_logs (
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
