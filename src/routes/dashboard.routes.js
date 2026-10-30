const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { validatePipeline } = require('../middleware/auth');

// All dashboard endpoints go through the multi-layer security validation pipeline
router.use(validatePipeline);

/**
 * @route   GET /api/dashboard/summary
 * @desc    Get dashboard metrics: pending receivable, payable, today's spent & received, due alerts
 * @access  Protected
 */
router.get('/summary', async (req, res) => {
  const userId = req.user.id;
  const today = new Date().toISOString().slice(0, 10);

  try {
    // Run all aggregate queries concurrently for lightning-fast response
    const [
      [givenRows],
      [takenRows],
      [todayGivenLoans],
      [todayTakenPayments],
      [todayGivenPayments],
      [todayTakenLoans],
      [activeLoans],
      [locationStats]
    ] = await Promise.all([
      // 1. Total Given Principal & Repaid
      pool.query(`
        SELECT 
          COALESCE(SUM(l.principal_amount), 0) as total_given_principal,
          COALESCE((
            SELECT SUM(p.amount) 
            FROM loan_payments p 
            JOIN loans l2 ON p.loan_id = l2.id 
            WHERE l2.user_id = ? AND l2.type = 'given'
          ), 0) as total_given_repaid
        FROM loans l
        WHERE l.user_id = ? AND l.type = 'given'
      `, [userId, userId]),

      // 2. Total Taken Principal & Repaid
      pool.query(`
        SELECT 
          COALESCE(SUM(l.principal_amount), 0) as total_taken_principal,
          COALESCE((
            SELECT SUM(p.amount) 
            FROM loan_payments p 
            JOIN loans l2 ON p.loan_id = l2.id 
            WHERE l2.user_id = ? AND l2.type = 'taken'
          ), 0) as total_taken_repaid
        FROM loans l
        WHERE l.user_id = ? AND l.type = 'taken'
      `, [userId, userId]),

      // 3. Today's Given Loans
      pool.query(`
        SELECT COALESCE(SUM(principal_amount), 0) as amount 
        FROM loans 
        WHERE user_id = ? AND type = 'given' AND issue_date = ?
      `, [userId, today]),

      // 4. Today's Taken Payments (Repaid by user)
      pool.query(`
        SELECT COALESCE(SUM(p.amount), 0) as amount 
        FROM loan_payments p 
        JOIN loans l ON p.loan_id = l.id 
        WHERE l.user_id = ? AND l.type = 'taken' AND p.payment_date = ?
      `, [userId, today]),

      // 5. Today's Given Payments (Received from borrowers)
      pool.query(`
        SELECT COALESCE(SUM(p.amount), 0) as amount 
        FROM loan_payments p 
        JOIN loans l ON p.loan_id = l.id 
        WHERE l.user_id = ? AND l.type = 'given' AND p.payment_date = ?
      `, [userId, today]),

      // 6. Today's Taken Loans (Borrowed today)
      pool.query(`
        SELECT COALESCE(SUM(principal_amount), 0) as amount 
        FROM loans 
        WHERE user_id = ? AND type = 'taken' AND issue_date = ?
      `, [userId, today]),

      // 7. Active Loans with Calculated Balance and Person Info
      pool.query(`
        SELECT 
          l.id,
          l.person_id,
          p.name as person_name,
          p.phone as person_phone,
          l.type,
          l.principal_amount,
          l.interest_rate,
          l.issue_date,
          l.due_date,
          l.location,
          l.status,
          l.notes,
          COALESCE(SUM(pay.amount), 0) as total_paid,
          (l.principal_amount - COALESCE(SUM(pay.amount), 0)) as remaining_balance,
          CASE 
            WHEN l.due_date IS NOT NULL AND l.due_date < ? AND (l.principal_amount - COALESCE(SUM(pay.amount), 0)) > 0 THEN 1 
            ELSE 0 
          END as is_overdue,
          CASE 
            WHEN l.due_date = ? AND (l.principal_amount - COALESCE(SUM(pay.amount), 0)) > 0 THEN 1 
            ELSE 0 
          END as is_due_today
        FROM loans l
        JOIN people p ON l.person_id = p.id
        LEFT JOIN loan_payments pay ON l.id = pay.loan_id
        WHERE l.user_id = ?
        GROUP BY l.id, p.name, p.phone
        HAVING remaining_balance > 0
        ORDER BY 
          is_overdue DESC, 
          is_due_today DESC, 
          l.due_date ASC, 
          remaining_balance DESC
      `, [today, today, userId]),

      // 8. Location Wise Aggregations
      pool.query(`
        SELECT 
          COALESCE(NULLIF(TRIM(location), ''), 'Unspecified') as location_name,
          COUNT(id) as total_loans,
          SUM(principal_amount) as total_amount,
          SUM(CASE WHEN type = 'given' THEN principal_amount ELSE 0 END) as given_amount,
          SUM(CASE WHEN type = 'taken' THEN principal_amount ELSE 0 END) as taken_amount
        FROM loans
        WHERE user_id = ?
        GROUP BY location_name
        ORDER BY total_amount DESC
      `, [userId])
    ]);

    const totalGivenPrincipal = parseFloat(givenRows[0].total_given_principal || 0);
    const totalGivenRepaid = parseFloat(givenRows[0].total_given_repaid || 0);
    const pendingReceivable = Math.max(0, totalGivenPrincipal - totalGivenRepaid);

    const totalTakenPrincipal = parseFloat(takenRows[0].total_taken_principal || 0);
    const totalTakenRepaid = parseFloat(takenRows[0].total_taken_repaid || 0);
    const pendingPayable = Math.max(0, totalTakenPrincipal - totalTakenRepaid);

    const todaySpent = parseFloat(todayGivenLoans[0].amount) + parseFloat(todayTakenPayments[0].amount);
    const todayReceived = parseFloat(todayGivenPayments[0].amount) + parseFloat(todayTakenLoans[0].amount);

    const peopleOweMe = activeLoans.filter(l => l.type === 'given');
    const peopleIOwe = activeLoans.filter(l => l.type === 'taken');

    return res.json({
      success: true,
      data: {
        todayDate: today,
        metrics: {
          pendingReceivable,
          pendingPayable,
          netPosition: pendingReceivable - pendingPayable,
          todaySpent,
          todayReceived,
          todayNet: todayReceived - todaySpent
        },
        peopleOweMe,
        peopleIOwe,
        activeLoansCount: activeLoans.length,
        locationStats
      }
    });

  } catch (err) {
    console.error('Error fetching dashboard summary:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve dashboard summary' });
  }
});

module.exports = router;
