const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { validatePipeline, requireAdmin } = require('../middleware/auth');

// All admin routes must cross validatePipeline AND requireAdmin
router.use(validatePipeline);
router.use(requireAdmin);

/**
 * @route   GET /api/admin/users
 * @desc    Get all users with their total pending loan balance & activity stats
 * @access  Admin Only
 */
router.get('/users', async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT 
        u.id,
        u.username,
        u.email,
        u.full_name,
        u.role,
        u.status,
        u.created_at,
        u.updated_at,
        (SELECT COUNT(*) FROM loans WHERE user_id = u.id) as total_loans,
        (SELECT COUNT(*) FROM people WHERE user_id = u.id) as total_contacts,
        COALESCE((SELECT SUM(principal_amount) FROM loans WHERE user_id = u.id AND type = 'given'), 0) as total_given_principal,
        COALESCE((SELECT SUM(principal_amount) FROM loans WHERE user_id = u.id AND type = 'taken'), 0) as total_taken_principal,
        COALESCE((
          SELECT SUM(pay.amount) 
          FROM loan_payments pay 
          JOIN loans l_sub ON pay.loan_id = l_sub.id 
          WHERE l_sub.user_id = u.id AND l_sub.type = 'given'
        ), 0) as total_given_repaid,
        COALESCE((
          SELECT SUM(pay.amount) 
          FROM loan_payments pay 
          JOIN loans l_sub ON pay.loan_id = l_sub.id 
          WHERE l_sub.user_id = u.id AND l_sub.type = 'taken'
        ), 0) as total_taken_repaid
      FROM users u
      ORDER BY u.created_at DESC
    `);

    const formatted = users.map(u => {
      const pendingReceivable = Math.max(0, parseFloat(u.total_given_principal) - parseFloat(u.total_given_repaid));
      const pendingPayable = Math.max(0, parseFloat(u.total_taken_principal) - parseFloat(u.total_taken_repaid));
      return {
        ...u,
        pendingReceivable,
        pendingPayable,
        totalPending: pendingReceivable + pendingPayable, // total amount pending under this user's purview
        netPosition: pendingReceivable - pendingPayable
      };
    });

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error fetching admin users:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve users' });
  }
});

/**
 * @route   POST /api/admin/users
 * @desc    Create new user by administrator
 * @access  Admin Only
 */
router.post('/users', async (req, res) => {
  const { username, email, password, full_name, role, status } = req.body;

  if (!username || !email || !password || !full_name) {
    return res.status(400).json({ success: false, error: 'Username, email, password, and full name are required' });
  }

  try {
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username.trim(), email.trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({ success: false, error: 'Username or email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userRole = role === 'admin' ? 'admin' : 'user';
    const userStatus = status === 'inactive' ? 'inactive' : 'active';

    const [result] = await pool.query(`
      INSERT INTO users (username, email, password_hash, full_name, role, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [username.trim(), email.trim(), passwordHash, full_name.trim(), userRole, userStatus]);

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      userId: result.insertId
    });
  } catch (err) {
    console.error('Error creating user by admin:', err);
    return res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

/**
 * @route   PUT /api/admin/users/:id
 * @desc    Update user details, role, status or password
 * @access  Admin Only
 */
router.put('/users/:id', async (req, res) => {
  const targetUserId = req.params.id;
  const { full_name, email, role, status, password } = req.body;

  try {
    const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [targetUserId]);
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    let passwordHash = userRows[0].password_hash;
    if (password && password.trim().length > 0) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    await pool.query(`
      UPDATE users SET
        full_name = COALESCE(?, full_name),
        email = COALESCE(?, email),
        role = COALESCE(?, role),
        status = COALESCE(?, status),
        password_hash = ?
      WHERE id = ?
    `, [
      full_name ? full_name.trim() : null,
      email ? email.trim() : null,
      role || null,
      status || null,
      passwordHash,
      targetUserId
    ]);

    return res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    console.error('Error updating user by admin:', err);
    return res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

/**
 * @route   DELETE /api/admin/users/:id
 * @desc    Delete user
 * @access  Admin Only
 */
router.delete('/users/:id', async (req, res) => {
  const targetUserId = req.params.id;

  if (parseInt(targetUserId, 10) === req.user.id) {
    return res.status(400).json({ success: false, error: 'Administrators cannot delete their own account' });
  }

  try {
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [targetUserId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('Error deleting user by admin:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

/**
 * @route   GET /api/admin/activity/monthly
 * @desc    View monthly activity summary across the system
 * @access  Admin Only
 */
router.get('/activity/monthly', async (req, res) => {
  try {
    const [monthlyLoans] = await pool.query(`
      SELECT 
        DATE_FORMAT(issue_date, '%Y-%m') as month_period,
        COUNT(id) as total_loans_created,
        SUM(CASE WHEN type = 'given' THEN principal_amount ELSE 0 END) as total_given_amount,
        SUM(CASE WHEN type = 'taken' THEN principal_amount ELSE 0 END) as total_taken_amount,
        COUNT(DISTINCT user_id) as active_users_count
      FROM loans
      GROUP BY month_period
      ORDER BY month_period DESC
      LIMIT 12
    `);

    const [monthlyPayments] = await pool.query(`
      SELECT 
        DATE_FORMAT(payment_date, '%Y-%m') as month_period,
        COUNT(id) as total_payments_count,
        SUM(amount) as total_repaid_amount
      FROM loan_payments
      GROUP BY month_period
      ORDER BY month_period DESC
      LIMIT 12
    `);

    // Merge loans & payments activity by month
    const activityMap = {};

    monthlyLoans.forEach(row => {
      activityMap[row.month_period] = {
        month: row.month_period,
        loansCreated: parseInt(row.total_loans_created, 10),
        givenAmount: parseFloat(row.total_given_amount || 0),
        takenAmount: parseFloat(row.total_taken_amount || 0),
        activeUsers: parseInt(row.active_users_count, 10),
        paymentsCount: 0,
        repaidAmount: 0
      };
    });

    monthlyPayments.forEach(row => {
      if (!activityMap[row.month_period]) {
        activityMap[row.month_period] = {
          month: row.month_period,
          loansCreated: 0,
          givenAmount: 0,
          takenAmount: 0,
          activeUsers: 0,
          paymentsCount: 0,
          repaidAmount: 0
        };
      }
      activityMap[row.month_period].paymentsCount = parseInt(row.total_payments_count, 10);
      activityMap[row.month_period].repaidAmount = parseFloat(row.total_repaid_amount || 0);
    });

    const sortedActivity = Object.values(activityMap).sort((a, b) => b.month.localeCompare(a.month));

    return res.json({ success: true, data: sortedActivity });
  } catch (err) {
    console.error('Error fetching monthly activity:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve monthly activity' });
  }
});

/**
 * @route   GET /api/admin/logs
 * @desc    View security & validation failure logs
 * @access  Admin Only
 */
router.get('/logs', async (req, res) => {
  const { limit = 50, status_code, client_type } = req.query;

  try {
    let sql = 'SELECT * FROM security_logs WHERE 1=1';
    const params = [];

    if (status_code) {
      sql += ' AND status_code = ?';
      params.push(status_code);
    }

    if (client_type) {
      sql += ' AND client_type = ?';
      params.push(client_type);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const [logs] = await pool.query(sql, params);

    return res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Error fetching security logs:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve security logs' });
  }
});

module.exports = router;
