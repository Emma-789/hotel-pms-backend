const express = require('express');
const pool = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Daily summary — defaults to today, or pass ?date=YYYY-MM-DD
// Bar/kitchen see only their own orders; reception sees payments + guest requests; owner sees everything
router.get('/daily', authenticateToken, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const dayStart = `${date} 00:00:00`;
    const dayEnd = `${date} 23:59:59`;

    if (req.user.role === 'bar' || req.user.role === 'kitchen') {
      const orders = await pool.query(
        `SELECT COUNT(*) AS order_count, COALESCE(SUM(amount),0) AS total_amount,
                COUNT(*) FILTER (WHERE payment_status = 'completed') AS completed_count,
                COUNT(*) FILTER (WHERE payment_status = 'pending') AS pending_count
         FROM orders WHERE order_type = $1 AND created_at BETWEEN $2 AND $3`,
        [req.user.role, dayStart, dayEnd]
      );
      return res.json({ success: true, date, department: req.user.role, orders: orders.rows[0] });
    }

    if (req.user.role === 'reception') {
      const payments = await pool.query(
        `SELECT COUNT(*) AS payment_count, COALESCE(SUM(amount),0) AS total_amount,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
         FROM payments WHERE created_at BETWEEN $1 AND $2`,
        [dayStart, dayEnd]
      );
      const requests = await pool.query(
        `SELECT COUNT(*) AS request_count,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
                COUNT(*) FILTER (WHERE status = 'open') AS open_count
         FROM guest_requests WHERE created_at BETWEEN $1 AND $2`,
        [dayStart, dayEnd]
      );
      return res.json({ success: true, date, department: 'reception', payments: payments.rows[0], guest_requests: requests.rows[0] });
    }

    // Owner: full picture across departments
    const ordersByDept = await pool.query(
      `SELECT order_type, COUNT(*) AS order_count, COALESCE(SUM(amount),0) AS total_amount
       FROM orders WHERE created_at BETWEEN $1 AND $2 GROUP BY order_type`,
      [dayStart, dayEnd]
    );
    const payments = await pool.query(
      `SELECT COUNT(*) AS payment_count, COALESCE(SUM(amount),0) AS total_amount,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
       FROM payments WHERE created_at BETWEEN $1 AND $2`,
      [dayStart, dayEnd]
    );
    const requests = await pool.query(
      `SELECT COUNT(*) AS request_count,
              COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
              COUNT(*) FILTER (WHERE status = 'open') AS open_count
       FROM guest_requests WHERE created_at BETWEEN $1 AND $2`,
      [dayStart, dayEnd]
    );
    const lowStock = await pool.query('SELECT COUNT(*) AS low_stock_count FROM inventory WHERE quantity <= min_quantity');

    res.json({
      success: true,
      date,
      orders_by_department: ordersByDept.rows,
      payments: payments.rows[0],
      guest_requests: requests.rows[0],
      low_stock_items: Number(lowStock.rows[0].low_stock_count)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
