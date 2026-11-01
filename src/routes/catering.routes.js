const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { validatePipeline } = require('../middleware/auth');

// All catering routes protected by session, cookie, csrf, and jwt pipeline
router.use(validatePipeline);

/**
 * Helper: Parse sessions array/json safely
 */
function parseSessions(sessions) {
  if (Array.isArray(sessions)) return sessions;
  if (typeof sessions === 'string') {
    try {
      const parsed = JSON.parse(sessions);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [sessions];
    }
  }
  return ['morning'];
}

/**
 * @route   GET /api/catering/summary
 * @desc    Get catering KPI overview metrics
 * @access  Protected
 */
router.get('/summary', async (req, res) => {
  const userId = req.user.id;

  try {
    const [services] = await pool.query(`
      SELECT 
        COUNT(id) as total_services,
        COUNT(CASE WHEN status = 'upcoming' THEN 1 END) as upcoming_services,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_services,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN status = 'upcoming' THEN total_amount ELSE 0 END), 0) as total_upcoming_amount,
        COALESCE(SUM(advance_amount), 0) as total_advance_received,
        COALESCE(SUM(pending_amount), 0) as total_pending_customer_amount
      FROM loan_catering_services
      WHERE user_id = ?
    `, [userId]);

    const [staffStats] = await pool.query(`
      SELECT 
        COUNT(DISTINCT member_id) as total_members_utilized,
        COALESCE(SUM(total_salary), 0) as total_staff_salary_obligation,
        COALESCE(SUM(paid_amount), 0) as total_staff_salary_paid
      FROM loan_catering_service_staff
      WHERE user_id = ?
    `, [userId]);

    const [memberCount] = await pool.query(`
      SELECT COUNT(id) as total_roster_members
      FROM loan_catering_members
      WHERE user_id = ? AND status = 'active'
    `, [userId]);

    const s = services[0];
    const st = staffStats[0];
    const totalStaffSalary = parseFloat(st.total_staff_salary_obligation || 0);
    const totalStaffPaid = parseFloat(st.total_staff_salary_paid || 0);

    return res.json({
      success: true,
      data: {
        totalServices: parseInt(s.total_services, 10),
        upcomingServices: parseInt(s.upcoming_services, 10),
        completedServices: parseInt(s.completed_services, 10),
        totalRevenue: parseFloat(s.total_revenue),
        totalUpcomingAmount: parseFloat(s.total_upcoming_amount),
        totalAdvanceReceived: parseFloat(s.total_advance_received),
        totalPendingCustomerAmount: parseFloat(s.total_pending_customer_amount),
        totalRosterMembers: parseInt(memberCount[0].total_roster_members, 10),
        totalStaffSalaryObligation: totalStaffSalary,
        totalStaffSalaryPaid: totalStaffPaid,
        pendingStaffSalaryToPay: Math.max(0, totalStaffSalary - totalStaffPaid)
      }
    });
  } catch (err) {
    console.error('Error fetching catering summary:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve catering summary' });
  }
});

/**
 * @route   GET /api/catering/services
 * @desc    Get all catering services with attached staff list and salary status
 * @access  Protected
 */
router.get('/services', async (req, res) => {
  const userId = req.user.id;
  const { status, search, from_date, to_date } = req.query;

  try {
    let sql = `
      SELECT 
        s.*,
        COUNT(ss.id) as staff_count,
        COALESCE(SUM(ss.total_salary), 0) as total_staff_salary,
        COALESCE(SUM(ss.paid_amount), 0) as total_staff_paid
      FROM loan_catering_services s
      LEFT JOIN loan_catering_service_staff ss ON s.id = ss.service_id
      WHERE s.user_id = ?
    `;
    const params = [userId];

    if (status) {
      sql += ' AND s.status = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (s.service_name LIKE ? OR s.customer_name LIKE ? OR s.location LIKE ? OR s.remarks LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    if (from_date) {
      sql += ' AND s.service_date >= ?';
      params.push(from_date);
    }

    if (to_date) {
      sql += ' AND s.service_date <= ?';
      params.push(to_date);
    }

    sql += ' GROUP BY s.id ORDER BY s.service_date ASC, s.created_at DESC';

    const [services] = await pool.query(sql, params);

    // Fetch all staff assignments for these services
    if (services.length > 0) {
      const serviceIds = services.map(s => s.id);
      const [staffRows] = await pool.query(`
        SELECT 
          ss.*,
          m.name as member_name,
          m.phone as member_phone,
          m.role as member_role
        FROM loan_catering_service_staff ss
        JOIN loan_catering_members m ON ss.member_id = m.id
        WHERE ss.service_id IN (?)
        ORDER BY ss.created_at ASC
      `, [serviceIds]);

      // Group staff by service_id
      const staffByService = {};
      staffRows.forEach(st => {
        if (!staffByService[st.service_id]) {
          staffByService[st.service_id] = [];
        }
        staffByService[st.service_id].push({
          id: st.id,
          member_id: st.member_id,
          name: st.member_name,
          phone: st.member_phone,
          role: st.member_role,
          worked_morning: Boolean(st.worked_morning),
          worked_afternoon: Boolean(st.worked_afternoon),
          worked_night: Boolean(st.worked_night),
          session_count: parseInt(st.session_count, 10),
          rate_per_session: parseFloat(st.rate_per_session),
          total_salary: parseFloat(st.total_salary),
          paid_amount: parseFloat(st.paid_amount),
          pending_salary: Math.max(0, parseFloat(st.total_salary) - parseFloat(st.paid_amount)),
          paid_status: st.paid_status,
          remarks: st.remarks
        });
      });

      services.forEach(srv => {
        srv.sessions = parseSessions(srv.sessions);
        srv.total_amount = parseFloat(srv.total_amount);
        srv.advance_amount = parseFloat(srv.advance_amount);
        srv.pending_amount = parseFloat(srv.pending_amount);
        srv.staff_count = parseInt(srv.staff_count, 10);
        srv.total_staff_salary = parseFloat(srv.total_staff_salary);
        srv.total_staff_paid = parseFloat(srv.total_staff_paid);
        srv.staff_list = staffByService[srv.id] || [];
      });
    }

    return res.json({ success: true, data: services });
  } catch (err) {
    console.error('Error fetching catering services:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve catering services' });
  }
});

/**
 * @route   GET /api/catering/services/:id
 * @desc    Get single catering service by id
 * @access  Protected
 */
router.get('/services/:id', async (req, res) => {
  const userId = req.user.id;
  const serviceId = req.params.id;

  try {
    const [rows] = await pool.query(
      'SELECT * FROM loan_catering_services WHERE id = ? AND user_id = ?',
      [serviceId, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Catering service not found' });
    }

    const service = rows[0];
    service.sessions = parseSessions(service.sessions);

    const [staff] = await pool.query(`
      SELECT 
        ss.*,
        m.name as member_name,
        m.phone as member_phone,
        m.role as member_role
      FROM loan_catering_service_staff ss
      JOIN loan_catering_members m ON ss.member_id = m.id
      WHERE ss.service_id = ?
      ORDER BY ss.created_at ASC
    `, [serviceId]);

    service.staff_list = staff.map(st => ({
      id: st.id,
      member_id: st.member_id,
      name: st.member_name,
      phone: st.member_phone,
      role: st.member_role,
      worked_morning: Boolean(st.worked_morning),
      worked_afternoon: Boolean(st.worked_afternoon),
      worked_night: Boolean(st.worked_night),
      session_count: parseInt(st.session_count, 10),
      rate_per_session: parseFloat(st.rate_per_session),
      total_salary: parseFloat(st.total_salary),
      paid_amount: parseFloat(st.paid_amount),
      pending_salary: Math.max(0, parseFloat(st.total_salary) - parseFloat(st.paid_amount)),
      paid_status: st.paid_status,
      remarks: st.remarks
    }));

    return res.json({ success: true, data: service });
  } catch (err) {
    console.error('Error fetching single service:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve service' });
  }
});

/**
 * @route   POST /api/catering/services
 * @desc    Create new catering service
 * @access  Protected
 */
router.post('/services', async (req, res) => {
  const userId = req.user.id;
  const {
    service_name,
    customer_name,
    customer_phone,
    service_date,
    sessions,
    location,
    map_link,
    total_amount,
    advance_amount,
    status = 'upcoming',
    remarks
  } = req.body;

  if (!service_name || !service_date || !location) {
    return res.status(400).json({
      success: false,
      error: 'Service name, event date, and location are required'
    });
  }

  const totalAmt = parseFloat(total_amount || 0);
  const advanceAmt = parseFloat(advance_amount || 0);
  const pendingAmt = Math.max(0, totalAmt - advanceAmt);
  const sessionsArr = parseSessions(sessions);

  try {
    const [result] = await pool.query(`
      INSERT INTO loan_catering_services
      (user_id, service_name, customer_name, customer_phone, service_date, sessions, location, map_link, total_amount, advance_amount, pending_amount, status, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      service_name,
      customer_name || null,
      customer_phone || null,
      service_date,
      JSON.stringify(sessionsArr),
      location,
      map_link || null,
      totalAmt,
      advanceAmt,
      pendingAmt,
      status,
      remarks || null
    ]);

    return res.status(201).json({
      success: true,
      message: 'Catering service order created successfully',
      serviceId: result.insertId
    });
  } catch (err) {
    console.error('Error creating catering service:', err);
    return res.status(500).json({ success: false, error: 'Failed to create catering service' });
  }
});

/**
 * @route   PUT /api/catering/services/:id
 * @desc    Update catering service
 * @access  Protected
 */
router.put('/services/:id', async (req, res) => {
  const userId = req.user.id;
  const serviceId = req.params.id;
  const {
    service_name,
    customer_name,
    customer_phone,
    service_date,
    sessions,
    location,
    map_link,
    total_amount,
    advance_amount,
    status,
    remarks
  } = req.body;

  try {
    const [existing] = await pool.query(
      'SELECT * FROM loan_catering_services WHERE id = ? AND user_id = ?',
      [serviceId, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'Catering service not found' });
    }

    const current = existing[0];
    const totalAmt = total_amount !== undefined ? parseFloat(total_amount) : parseFloat(current.total_amount);
    const advanceAmt = advance_amount !== undefined ? parseFloat(advance_amount) : parseFloat(current.advance_amount);
    const pendingAmt = Math.max(0, totalAmt - advanceAmt);
    const sessionsArr = sessions !== undefined ? parseSessions(sessions) : parseSessions(current.sessions);

    await pool.query(`
      UPDATE loan_catering_services
      SET service_name = ?, customer_name = ?, customer_phone = ?, service_date = ?,
          sessions = ?, location = ?, map_link = ?, total_amount = ?, advance_amount = ?,
          pending_amount = ?, status = ?, remarks = ?
      WHERE id = ? AND user_id = ?
    `, [
      service_name || current.service_name,
      customer_name !== undefined ? customer_name : current.customer_name,
      customer_phone !== undefined ? customer_phone : current.customer_phone,
      service_date || current.service_date,
      JSON.stringify(sessionsArr),
      location || current.location,
      map_link !== undefined ? map_link : current.map_link,
      totalAmt,
      advanceAmt,
      pendingAmt,
      status || current.status,
      remarks !== undefined ? remarks : current.remarks,
      serviceId,
      userId
    ]);

    return res.json({ success: true, message: 'Catering service updated successfully' });
  } catch (err) {
    console.error('Error updating catering service:', err);
    return res.status(500).json({ success: false, error: 'Failed to update catering service' });
  }
});

/**
 * @route   DELETE /api/catering/services/:id
 * @desc    Delete catering service
 * @access  Protected
 */
router.delete('/services/:id', async (req, res) => {
  const userId = req.user.id;
  const serviceId = req.params.id;

  try {
    const [resDel] = await pool.query(
      'DELETE FROM loan_catering_services WHERE id = ? AND user_id = ?',
      [serviceId, userId]
    );

    if (resDel.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Catering service not found' });
    }

    return res.json({ success: true, message: 'Catering service deleted successfully' });
  } catch (err) {
    console.error('Error deleting catering service:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete catering service' });
  }
});

/**
 * @route   POST /api/catering/services/:id/staff
 * @desc    Assign / add staff member to catering service with shift salary calculation
 *          Rule: 1 shift = 300, 2 shifts = 600, 3 shifts = 900
 * @access  Protected
 */
router.post('/services/:id/staff', async (req, res) => {
  const userId = req.user.id;
  const serviceId = req.params.id;
  const {
    member_id,
    new_member,
    worked_morning = false,
    worked_afternoon = false,
    worked_night = false,
    rate_per_session = 300.00,
    remarks
  } = req.body;

  try {
    // 1. Verify service ownership
    const [services] = await pool.query(
      'SELECT id FROM loan_catering_services WHERE id = ? AND user_id = ?',
      [serviceId, userId]
    );
    if (services.length === 0) {
      return res.status(404).json({ success: false, error: 'Catering service not found' });
    }

    // 2. Resolve member_id
    let assignedMemberId = member_id;
    if (!assignedMemberId && new_member && new_member.name) {
      const [newMemRes] = await pool.query(`
        INSERT INTO loan_catering_members (user_id, name, phone, role, notes)
        VALUES (?, ?, ?, ?, ?)
      `, [
        userId,
        new_member.name,
        new_member.phone || '',
        new_member.role || 'Service Staff',
        new_member.notes || null
      ]);
      assignedMemberId = newMemRes.insertId;
    }

    if (!assignedMemberId) {
      return res.status(400).json({ success: false, error: 'Please select or provide staff member details' });
    }

    // 3. Calculate session count and total salary
    // If worked morning only => 1 shift (300)
    // If worked 2 shifts => 2 shifts (600)
    // If worked 3 shifts => 3 shifts (900)
    const mFlag = Boolean(worked_morning);
    const aFlag = Boolean(worked_afternoon);
    const nFlag = Boolean(worked_night);
    let sessionCount = (mFlag ? 1 : 0) + (aFlag ? 1 : 0) + (nFlag ? 1 : 0);
    if (sessionCount === 0) sessionCount = 1; // Default to at least 1 shift if none explicitly ticked

    const rate = parseFloat(rate_per_session) || 300.00;
    const totalSalary = sessionCount * rate;

    // Check if member already assigned to this service
    const [existingStaff] = await pool.query(
      'SELECT id FROM loan_catering_service_staff WHERE service_id = ? AND member_id = ?',
      [serviceId, assignedMemberId]
    );

    if (existingStaff.length > 0) {
      // Update existing record
      await pool.query(`
        UPDATE loan_catering_service_staff
        SET worked_morning = ?, worked_afternoon = ?, worked_night = ?,
            session_count = ?, rate_per_session = ?, total_salary = ?, remarks = ?
        WHERE id = ?
      `, [
        mFlag, aFlag, nFlag,
        sessionCount, rate, totalSalary, remarks || null,
        existingStaff[0].id
      ]);

      return res.json({
        success: true,
        message: `Updated ${sessionCount} shift(s) for member. Total salary: ₹${totalSalary}`,
        staffId: existingStaff[0].id,
        sessionCount,
        totalSalary
      });
    }

    // Insert new staff assignment
    const [result] = await pool.query(`
      INSERT INTO loan_catering_service_staff
      (service_id, member_id, user_id, worked_morning, worked_afternoon, worked_night, session_count, rate_per_session, total_salary, paid_amount, paid_status, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.00, 'pending', ?)
    `, [
      serviceId,
      assignedMemberId,
      userId,
      mFlag,
      aFlag,
      nFlag,
      sessionCount,
      rate,
      totalSalary,
      remarks || null
    ]);

    return res.status(201).json({
      success: true,
      message: `Staff member assigned (${sessionCount} shift(s) = ₹${totalSalary})`,
      staffId: result.insertId,
      sessionCount,
      totalSalary
    });
  } catch (err) {
    console.error('Error assigning staff member:', err);
    return res.status(500).json({ success: false, error: 'Failed to assign staff member' });
  }
});

/**
 * @route   PUT /api/catering/services/:serviceId/staff/:staffId
 * @desc    Update staff member shifts worked on this service
 * @access  Protected
 */
router.put('/services/:serviceId/staff/:staffId', async (req, res) => {
  const userId = req.user.id;
  const { serviceId, staffId } = req.params;
  const { worked_morning, worked_afternoon, worked_night, rate_per_session = 300, remarks } = req.body;

  try {
    const [staffRows] = await pool.query(
      'SELECT * FROM loan_catering_service_staff WHERE id = ? AND service_id = ? AND user_id = ?',
      [staffId, serviceId, userId]
    );

    if (staffRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Staff assignment not found' });
    }

    const current = staffRows[0];
    const mFlag = worked_morning !== undefined ? Boolean(worked_morning) : Boolean(current.worked_morning);
    const aFlag = worked_afternoon !== undefined ? Boolean(worked_afternoon) : Boolean(current.worked_afternoon);
    const nFlag = worked_night !== undefined ? Boolean(worked_night) : Boolean(current.worked_night);

    let sessionCount = (mFlag ? 1 : 0) + (aFlag ? 1 : 0) + (nFlag ? 1 : 0);
    if (sessionCount === 0) sessionCount = 1;

    const rate = parseFloat(rate_per_session) || 300.00;
    const totalSalary = sessionCount * rate;
    const paidAmount = parseFloat(current.paid_amount || 0);

    let paidStatus = 'pending';
    if (paidAmount >= totalSalary) {
      paidStatus = 'paid';
    } else if (paidAmount > 0) {
      paidStatus = 'partially_paid';
    }

    await pool.query(`
      UPDATE loan_catering_service_staff
      SET worked_morning = ?, worked_afternoon = ?, worked_night = ?,
          session_count = ?, rate_per_session = ?, total_salary = ?, paid_status = ?, remarks = ?
      WHERE id = ?
    `, [
      mFlag, aFlag, nFlag,
      sessionCount, rate, totalSalary, paidStatus,
      remarks !== undefined ? remarks : current.remarks,
      staffId
    ]);

    return res.json({
      success: true,
      message: `Updated shifts (${sessionCount} shift(s) = ₹${totalSalary})`,
      sessionCount,
      totalSalary,
      paidStatus
    });
  } catch (err) {
    console.error('Error updating staff shift:', err);
    return res.status(500).json({ success: false, error: 'Failed to update staff shift' });
  }
});

/**
 * @route   DELETE /api/catering/services/:serviceId/staff/:staffId
 * @desc    Remove staff member from service
 * @access  Protected
 */
router.delete('/services/:serviceId/staff/:staffId', async (req, res) => {
  const userId = req.user.id;
  const { serviceId, staffId } = req.params;

  try {
    const [delRes] = await pool.query(
      'DELETE FROM loan_catering_service_staff WHERE id = ? AND service_id = ? AND user_id = ?',
      [staffId, serviceId, userId]
    );

    if (delRes.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Staff assignment not found' });
    }

    return res.json({ success: true, message: 'Staff member removed from service' });
  } catch (err) {
    console.error('Error removing staff:', err);
    return res.status(500).json({ success: false, error: 'Failed to remove staff' });
  }
});

/**
 * @route   POST /api/catering/services/:serviceId/staff/:staffId/pay
 * @desc    Mark staff salary as paid / Record staff payment with immutable history log
 * @access  Protected
 */
router.post('/services/:serviceId/staff/:staffId/pay', async (req, res) => {
  const userId = req.user.id;
  const { serviceId, staffId } = req.params;
  const {
    amount,
    payment_date = new Date().toISOString().slice(0, 10),
    payment_method = 'cash',
    notes
  } = req.body;

  try {
    const [staffRows] = await pool.query(`
      SELECT ss.*, m.name as member_name
      FROM loan_catering_service_staff ss
      JOIN loan_catering_members m ON ss.member_id = m.id
      WHERE ss.id = ? AND ss.service_id = ? AND ss.user_id = ?
    `, [staffId, serviceId, userId]);

    if (staffRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Staff assignment not found' });
    }

    const staff = staffRows[0];
    const totalSalary = parseFloat(staff.total_salary);
    const existingPaid = parseFloat(staff.paid_amount || 0);
    const remainingPending = Math.max(0, totalSalary - existingPaid);

    // If amount not passed or 0, default to paying the full remaining pending salary
    const payAmount = (amount !== undefined && amount !== null && parseFloat(amount) > 0)
      ? parseFloat(amount)
      : remainingPending;

    if (payAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Staff salary has already been fully paid' });
    }

    const newPaidAmount = existingPaid + payAmount;
    const newPaidStatus = newPaidAmount >= totalSalary ? 'paid' : 'partially_paid';

    // 1. Update staff assignment paid amount and status
    await pool.query(`
      UPDATE loan_catering_service_staff
      SET paid_amount = ?, paid_status = ?
      WHERE id = ?
    `, [newPaidAmount, newPaidStatus, staffId]);

    // 2. Insert audit payment log into loan_catering_staff_payments
    const [payLog] = await pool.query(`
      INSERT INTO loan_catering_staff_payments
      (service_staff_id, service_id, member_id, user_id, amount, payment_date, payment_method, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      staffId,
      serviceId,
      staff.member_id,
      userId,
      payAmount,
      payment_date,
      payment_method,
      notes || `Salary payment for ${staff.member_name} (${staff.session_count} shift(s))`
    ]);

    return res.json({
      success: true,
      message: `Recorded payment of ₹${payAmount} to ${staff.member_name}. Status: ${newPaidStatus}`,
      paymentId: payLog.insertId,
      paidAmount: newPaidAmount,
      paidStatus: newPaidStatus,
      remainingPending: Math.max(0, totalSalary - newPaidAmount)
    });
  } catch (err) {
    console.error('Error recording staff payment:', err);
    return res.status(500).json({ success: false, error: 'Failed to record staff payment' });
  }
});

/**
 * @route   GET /api/catering/members
 * @desc    Get staff members directory with all-time salary earned, paid & pending balance
 * @access  Protected
 */
router.get('/members', async (req, res) => {
  const userId = req.user.id;

  try {
    const [members] = await pool.query(`
      SELECT 
        m.*,
        COUNT(ss.id) as total_services_worked,
        COALESCE(SUM(ss.total_salary), 0) as total_salary_earned,
        COALESCE(SUM(ss.paid_amount), 0) as total_salary_paid
      FROM loan_catering_members m
      LEFT JOIN loan_catering_service_staff ss ON m.id = ss.member_id
      WHERE m.user_id = ?
      GROUP BY m.id
      ORDER BY m.name ASC
    `, [userId]);

    const formatted = members.map(m => {
      const earned = parseFloat(m.total_salary_earned || 0);
      const paid = parseFloat(m.total_salary_paid || 0);
      return {
        ...m,
        total_services_worked: parseInt(m.total_services_worked, 10),
        total_salary_earned: earned,
        total_salary_paid: paid,
        pending_balance: Math.max(0, earned - paid)
      };
    });

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error fetching catering members:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve members' });
  }
});

/**
 * @route   POST /api/catering/members
 * @desc    Create new staff member
 * @access  Protected
 */
router.post('/members', async (req, res) => {
  const userId = req.user.id;
  const { name, phone, role = 'Server', notes } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ success: false, error: 'Member name and contact phone are required' });
  }

  try {
    const [result] = await pool.query(`
      INSERT INTO loan_catering_members (user_id, name, phone, role, notes)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, name, phone, role, notes || null]);

    return res.status(201).json({
      success: true,
      message: 'Staff member added to roster',
      memberId: result.insertId
    });
  } catch (err) {
    console.error('Error creating catering member:', err);
    return res.status(500).json({ success: false, error: 'Failed to create member' });
  }
});

/**
 * @route   PUT /api/catering/members/:id
 * @desc    Update staff member
 * @access  Protected
 */
router.put('/members/:id', async (req, res) => {
  const userId = req.user.id;
  const memberId = req.params.id;
  const { name, phone, role, notes, status } = req.body;

  try {
    const [existing] = await pool.query(
      'SELECT * FROM loan_catering_members WHERE id = ? AND user_id = ?',
      [memberId, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'Staff member not found' });
    }

    const current = existing[0];
    await pool.query(`
      UPDATE loan_catering_members
      SET name = ?, phone = ?, role = ?, notes = ?, status = ?
      WHERE id = ? AND user_id = ?
    `, [
      name || current.name,
      phone || current.phone,
      role || current.role,
      notes !== undefined ? notes : current.notes,
      status || current.status,
      memberId,
      userId
    ]);

    return res.json({ success: true, message: 'Member details updated successfully' });
  } catch (err) {
    console.error('Error updating catering member:', err);
    return res.status(500).json({ success: false, error: 'Failed to update member' });
  }
});

/**
 * @route   DELETE /api/catering/members/:id
 * @desc    Delete staff member
 * @access  Protected
 */
router.delete('/members/:id', async (req, res) => {
  const userId = req.user.id;
  const memberId = req.params.id;

  try {
    const [delRes] = await pool.query(
      'DELETE FROM loan_catering_members WHERE id = ? AND user_id = ?',
      [memberId, userId]
    );

    if (delRes.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Staff member not found' });
    }

    return res.json({ success: true, message: 'Member deleted from roster' });
  } catch (err) {
    console.error('Error deleting catering member:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete member' });
  }
});

/**
 * @route   GET /api/catering/payments/logs
 * @desc    Get chronological salary payment log history
 * @access  Protected
 */
router.get('/payments/logs', async (req, res) => {
  const userId = req.user.id;
  const { member_id, service_id, limit = 100 } = req.query;

  try {
    let sql = `
      SELECT 
        p.*,
        m.name as member_name,
        m.phone as member_phone,
        m.role as member_role,
        s.service_name,
        s.service_date,
        s.location as service_location
      FROM loan_catering_staff_payments p
      JOIN loan_catering_members m ON p.member_id = m.id
      LEFT JOIN loan_catering_services s ON p.service_id = s.id
      WHERE p.user_id = ?
    `;
    const params = [userId];

    if (member_id) {
      sql += ' AND p.member_id = ?';
      params.push(member_id);
    }

    if (service_id) {
      sql += ' AND p.service_id = ?';
      params.push(service_id);
    }

    sql += ' ORDER BY p.payment_date DESC, p.created_at DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const [logs] = await pool.query(sql, params);

    const formatted = logs.map(l => ({
      ...l,
      amount: parseFloat(l.amount)
    }));

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error fetching payment logs:', err);
    return res.status(500).json({ success: false, error: 'Failed to retrieve payment logs' });
  }
});

module.exports = router;
