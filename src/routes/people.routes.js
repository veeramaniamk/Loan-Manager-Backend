const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { validatePipeline } = require('../middleware/auth');

router.use(validatePipeline);

/**
 * @route   GET /api/people
 * @desc    Get all people with their total lent, borrowed, and pending balances
 * @access  Protected
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;
  try {
    const [people] = await pool.query(`
      SELECT 
        p.*,
        COUNT(DISTINCT l.id) as total_loans,
        COALESCE(SUM(CASE WHEN l.type = 'given' THEN l.principal_amount ELSE 0 END), 0) as total_given,
        COALESCE(SUM(CASE WHEN l.type = 'taken' THEN l.principal_amount ELSE 0 END), 0) as total_taken,
        COALESCE((
          SELECT SUM(pay.amount) 
          FROM loan_payments pay 
          JOIN loans l_sub ON pay.loan_id = l_sub.id 
          WHERE l_sub.person_id = p.id AND l_sub.type = 'given'
        ), 0) as total_given_repaid,
        COALESCE((
          SELECT SUM(pay.amount) 
          FROM loan_payments pay 
          JOIN loans l_sub ON pay.loan_id = l_sub.id 
          WHERE l_sub.person_id = p.id AND l_sub.type = 'taken'
        ), 0) as total_taken_repaid
      FROM people p
      LEFT JOIN loans l ON p.id = l.person_id
      WHERE p.user_id = ?
      GROUP BY p.id
      ORDER BY p.name ASC
    `, [userId]);

    const formatted = people.map(p => {
      const pendingReceivable = Math.max(0, parseFloat(p.total_given) - parseFloat(p.total_given_repaid));
      const pendingPayable = Math.max(0, parseFloat(p.total_taken) - parseFloat(p.total_taken_repaid));
      return {
        ...p,
        pendingReceivable,
        pendingPayable,
        netBalance: pendingReceivable - pendingPayable // positive = they owe me, negative = I owe them
      };
    });

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error fetching people:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve people' });
  }
});

/**
 * @route   GET /api/people/:id
 * @desc    Get single person with all their loans and payment details
 * @access  Protected
 */
router.get('/:id', async (req, res) => {
  const userId = req.user.id;
  const personId = req.params.id;

  try {
    const [personRows] = await pool.query(
      'SELECT * FROM people WHERE id = ? AND user_id = ?',
      [personId, userId]
    );

    if (personRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Person not found' });
    }

    const person = personRows[0];

    const [loans] = await pool.query(`
      SELECT 
        l.*,
        COALESCE(SUM(pay.amount), 0) as total_paid,
        (l.principal_amount - COALESCE(SUM(pay.amount), 0)) as remaining_balance
      FROM loans l
      LEFT JOIN loan_payments pay ON l.id = pay.loan_id
      WHERE l.person_id = ? AND l.user_id = ?
      GROUP BY l.id
      ORDER BY l.issue_date DESC
    `, [personId, userId]);

    return res.json({
      success: true,
      data: {
        ...person,
        loans
      }
    });
  } catch (err) {
    console.error('Error fetching person details:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve person details' });
  }
});

/**
 * @route   POST /api/people
 * @desc    Create new contact/person
 * @access  Protected
 */
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { name, phone, email, location, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Person name is required' });
  }

  try {
    const [result] = await pool.query(`
      INSERT INTO people (user_id, name, phone, email, location, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [userId, name.trim(), phone || null, email || null, location || null, notes || null]);

    return res.status(201).json({
      success: true,
      message: 'Person created successfully',
      personId: result.insertId
    });
  } catch (err) {
    console.error('Error creating person:', err);
    return res.status(500).json({ success: false, error: 'Failed to create person' });
  }
});

/**
 * @route   PUT /api/people/:id
 * @desc    Update person details
 * @access  Protected
 */
router.put('/:id', async (req, res) => {
  const userId = req.user.id;
  const personId = req.params.id;
  const { name, phone, email, location, notes } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Person name is required' });
  }

  try {
    const [result] = await pool.query(`
      UPDATE people 
      SET name = ?, phone = ?, email = ?, location = ?, notes = ?
      WHERE id = ? AND user_id = ?
    `, [name.trim(), phone || null, email || null, location || null, notes || null, personId, userId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Person not found' });
    }

    return res.json({ success: true, message: 'Person updated successfully' });
  } catch (err) {
    console.error('Error updating person:', err);
    return res.status(500).json({ success: false, error: 'Failed to update person' });
  }
});

/**
 * @route   DELETE /api/people/:id
 * @desc    Delete person and their associated loans
 * @access  Protected
 */
router.delete('/:id', async (req, res) => {
  const userId = req.user.id;
  const personId = req.params.id;

  try {
    const [result] = await pool.query(
      'DELETE FROM people WHERE id = ? AND user_id = ?',
      [personId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Person not found' });
    }

    return res.json({ success: true, message: 'Person deleted successfully' });
  } catch (err) {
    console.error('Error deleting person:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete person' });
  }
});

module.exports = router;
