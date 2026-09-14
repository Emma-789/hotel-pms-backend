const express = require('express');
const pool = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const { sendOwnerAlert } = require('../utils/notify');

const router = express.Router();

// Record a payment (cash, card, or transfer)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { amount, payment_method, room_number, status, reference_number, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO payments (amount, payment_method, room_number, status, reference_number, notes, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [amount, payment_method, room_number, status || 'completed', reference_number, notes, req.user.id]
    );

    const payment = result.rows[0];

    // If payment failed, create an alert and send email
    if (status === 'failed') {
      await pool.query(
        'INSERT INTO payment_alerts (payment_id, alert_type, description) VALUES ($1, $2, $3)',
        [payment.id, 'failed', `Payment of ${amount} via ${payment_method} failed for room ${room_number}`]
      );

      await sendOwnerAlert(
        '⚠️ Payment Failed Alert - Hotel PMS',
        `A payment of ₦${amount} via ${payment_method} failed for room ${room_number}.\n\nPlease check the system for details.`
      );
    }
    res.json({ success: true, payment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all payments
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payments ORDER BY created_at DESC');
    res.json({ success: true, payments: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
