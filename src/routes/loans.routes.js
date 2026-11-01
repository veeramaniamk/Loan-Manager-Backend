const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { validatePipeline } = require('../middleware/auth');

router.use(validatePipeline);

/**
 * Helper to update loan status based on total payments and due date
 */
async function syncLoanStatus(connection, loanId) {
  const [loanRows] = await connection.query(
    'SELECT principal_amount, due_date, status FROM loan_loans WHERE id = ?',
    [loanId]
  );
  if (loanRows.length === 0) return;

  const loan = loanRows[0];
  const [payRows] = await connection.query(
    'SELECT COALESCE(SUM(amount), 0) as total_paid FROM loan_payments WHERE loan_id = ?',
    [loanId]
  );

  const totalPaid = parseFloat(payRows[0].total_paid || 0);
  const principal = parseFloat(loan.principal_amount);
  const today = new Date().toISOString().slice(0, 10);

  let newStatus = 'pending';
  if (totalPaid >= principal) {
    newStatus = 'settled';
  } else if (totalPaid > 0) {
    newStatus = 'partially_paid';
  } else if (loan.due_date && loan.due_date < today) {
    newStatus = 'overdue';
  }

  await connection.query('UPDATE loan_loans SET status = ? WHERE id = ?', [newStatus, loanId]);
}

/**
 * @route   GET /api/loans
 * @desc    Filter and search loans
 * @access  Protected
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { type, status, person_id, location, search, from_date, to_date } = req.query;

  try {
    let sql = `
      SELECT 
        l.*,
        p.name as person_name,
        p.phone as person_phone,
        p.email as person_email,
        COALESCE(SUM(pay.amount), 0) as total_paid,
        (l.principal_amount - COALESCE(SUM(pay.amount), 0)) as remaining_balance
      FROM loan_loans l
      JOIN loan_people p ON l.person_id = p.id
      LEFT JOIN loan_payments pay ON l.id = pay.loan_id
      WHERE l.user_id = ?
    `;
    const params = [userId];

    if (type && (type === 'given' || type === 'taken')) {
      sql += ' AND l.type = ?';
      params.push(type);
    }

    if (status) {
      sql += ' AND l.status = ?';
      params.push(status);
    }

    if (person_id) {
      sql += ' AND l.person_id = ?';
      params.push(person_id);
    }

    if (location) {
      sql += ' AND l.location LIKE ?';
      params.push(`%${location}%`);
    }

    if (from_date) {
      sql += ' AND l.issue_date >= ?';
      params.push(from_date);
    }

    if (to_date) {
      sql += ' AND l.issue_date <= ?';
      params.push(to_date);
    }

    if (search) {
      sql += ' AND (p.name LIKE ? OR l.notes LIKE ? OR l.location LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' GROUP BY l.id, p.name, p.phone, p.email ORDER BY l.issue_date DESC, l.id DESC';

    const [loans] = await pool.query(sql, params);

    return res.json({ success: true, data: loans });
  } catch (err) {
    console.error('Error fetching loans:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve loans' });
  }
});

/**
 * @route   GET /api/loans/:id
 * @desc    Get loan by ID with complete payment ledger
 * @access  Protected
 */
router.get('/:id', async (req, res) => {
  const userId = req.user.id;
  const loanId = req.params.id;

  try {
    const [loanRows] = await pool.query(`
      SELECT 
        l.*,
        p.name as person_name,
        p.phone as person_phone,
        p.email as person_email,
        p.location as person_location,
        COALESCE(SUM(pay.amount), 0) as total_paid,
        (l.principal_amount - COALESCE(SUM(pay.amount), 0)) as remaining_balance
      FROM loan_loans l
      JOIN loan_people p ON l.person_id = p.id
      LEFT JOIN loan_payments pay ON l.id = pay.loan_id
      WHERE l.id = ? AND l.user_id = ?
      GROUP BY l.id, p.name, p.phone, p.email, p.location
    `, [loanId, userId]);

    if (loanRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Loan not found' });
    }

    const loan = loanRows[0];

    const [payments] = await pool.query(`
      SELECT * FROM loan_payments 
      WHERE loan_id = ? AND user_id = ?
      ORDER BY payment_date DESC, id DESC
    `, [loanId, userId]);

    return res.json({
      success: true,
      data: {
        ...loan,
        payments
      }
    });
  } catch (err) {
    console.error('Error fetching loan details:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve loan details' });
  }
});

/**
 * @route   POST /api/loans
 * @desc    Create a new loan
 * @access  Protected
 */
router.post('/', async (req, res) => {
  const userId = req.user.id;
  let {
    person_id,
    person_name,
    person_phone,
    type, // 'given' or 'taken'
    principal_amount,
    interest_rate,
    issue_date,
    due_date,
    location,
    notes
  } = req.body;

  if (!type || (type !== 'given' && type !== 'taken')) {
    return res.status(400).json({ success: false, error: "Type must be either 'given' or 'taken'" });
  }

  if (!principal_amount || isNaN(principal_amount) || parseFloat(principal_amount) <= 0) {
    return res.status(400).json({ success: false, error: 'Valid principal amount is required' });
  }

  if (!issue_date) {
    issue_date = new Date().toISOString().slice(0, 10);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // If person_id is not provided, but person_name is, find or create the person
    if (!person_id && person_name && person_name.trim()) {
      const [existingPerson] = await connection.query(
        'SELECT id FROM loan_people WHERE user_id = ? AND name = ?',
        [userId, person_name.trim()]
      );

      if (existingPerson.length > 0) {
        person_id = existingPerson[0].id;
      } else {
        const [newPerson] = await connection.query(`
          INSERT INTO loan_people (user_id, name, phone, location)
          VALUES (?, ?, ?, ?)
        `, [userId, person_name.trim(), person_phone || null, location || null]);
        person_id = newPerson.insertId;
      }
    }

    if (!person_id) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, error: 'Person selection or name is required' });
    }

    const [result] = await connection.query(`
      INSERT INTO loan_loans 
      (user_id, person_id, type, principal_amount, interest_rate, issue_date, due_date, location, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `, [
      userId,
      person_id,
      type,
      parseFloat(principal_amount),
      interest_rate ? parseFloat(interest_rate) : 0,
      issue_date,
      due_date || null,
      location || null,
      notes || null
    ]);

    await connection.commit();
    connection.release();

    return res.status(201).json({
      success: true,
      message: 'Loan recorded successfully',
      loanId: result.insertId
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Error creating loan:', err);
    return res.status(500).json({ success: false, error: 'Failed to record loan' });
  }
});

/**
 * @route   PUT /api/loans/:id
 * @desc    Update loan details
 * @access  Protected
 */
router.put('/:id', async (req, res) => {
  const userId = req.user.id;
  const loanId = req.params.id;
  const {
    person_id,
    type,
    principal_amount,
    interest_rate,
    issue_date,
    due_date,
    location,
    notes
  } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [existing] = await connection.query(
      'SELECT id FROM loan_loans WHERE id = ? AND user_id = ?',
      [loanId, userId]
    );

    if (existing.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, error: 'Loan not found' });
    }

    await connection.query(`
      UPDATE loan_loans SET
        person_id = COALESCE(?, person_id),
        type = COALESCE(?, type),
        principal_amount = COALESCE(?, principal_amount),
        interest_rate = COALESCE(?, interest_rate),
        issue_date = COALESCE(?, issue_date),
        due_date = ?,
        location = COALESCE(?, location),
        notes = ?
      WHERE id = ? AND user_id = ?
    `, [
      person_id || null,
      type || null,
      principal_amount ? parseFloat(principal_amount) : null,
      interest_rate !== undefined ? parseFloat(interest_rate) : null,
      issue_date || null,
      due_date || null,
      location || null,
      notes || null,
      loanId,
      userId
    ]);

    await syncLoanStatus(connection, loanId);

    await connection.commit();
    connection.release();

    return res.json({ success: true, message: 'Loan updated successfully' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Error updating loan:', err);
    return res.status(500).json({ success: false, error: 'Failed to update loan' });
  }
});

/**
 * @route   DELETE /api/loans/:id
 * @desc    Delete a loan
 * @access  Protected
 */
router.delete('/:id', async (req, res) => {
  const userId = req.user.id;
  const loanId = req.params.id;

  try {
    const [result] = await pool.query(
      'DELETE FROM loan_loans WHERE id = ? AND user_id = ?',
      [loanId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Loan not found' });
    }

    return res.json({ success: true, message: 'Loan deleted successfully' });
  } catch (err) {
    console.error('Error deleting loan:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete loan' });
  }
});

/**
 * @route   POST /api/loans/:id/payments
 * @desc    Add a payment/repayment to a loan
 * @access  Protected
 */
router.post('/:id/payments', async (req, res) => {
  const userId = req.user.id;
  const loanId = req.params.id;
  const { amount, payment_date, payment_method, notes } = req.body;

  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ success: false, error: 'Valid payment amount is required' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [loanRows] = await connection.query(
      'SELECT id FROM loan_loans WHERE id = ? AND user_id = ?',
      [loanId, userId]
    );

    if (loanRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, error: 'Loan not found' });
    }

    const payDate = payment_date || new Date().toISOString().slice(0, 10);

    const [payResult] = await connection.query(`
      INSERT INTO loan_payments (loan_id, user_id, payment_date, amount, payment_method, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [loanId, userId, payDate, parseFloat(amount), payment_method || 'cash', notes || null]);

    // Recalculate loan status
    await syncLoanStatus(connection, loanId);

    await connection.commit();
    connection.release();

    return res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      paymentId: payResult.insertId
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Error recording payment:', err);
    return res.status(500).json({ success: false, error: 'Failed to record payment' });
  }
});

/**
 * @route   DELETE /api/loans/:id/payments/:paymentId
 * @desc    Delete a payment record
 * @access  Protected
 */
router.delete('/:id/payments/:paymentId', async (req, res) => {
  const userId = req.user.id;
  const { id: loanId, paymentId } = req.params;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      'DELETE FROM loan_payments WHERE id = ? AND loan_id = ? AND user_id = ?',
      [paymentId, loanId, userId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, error: 'Payment record not found' });
    }

    await syncLoanStatus(connection, loanId);

    await connection.commit();
    connection.release();

    return res.json({ success: true, message: 'Payment record removed successfully' });
  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Error deleting payment:', err);
    return res.status(500).json({ success: false, error: 'Failed to remove payment' });
  }
});

module.exports = router;
