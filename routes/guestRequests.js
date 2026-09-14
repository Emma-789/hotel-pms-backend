const express = require('express');
const pool = require('../config/db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Create guest request
router.post('/', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const { room_number, request_type, description, priority } = req.body;
    const result = await pool.query(
      'INSERT INTO guest_requests (room_number, request_type, description, priority) VALUES ($1, $2, $3, $4) RETURNING *',
      [room_number, request_type, description, priority || 'normal']
    );
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all guest requests
router.get('/', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guest_requests ORDER BY created_at DESC');
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update guest request status
router.put('/:id', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const completed_at = status === 'completed' ? 'NOW()' : 'NULL';
    const result = await pool.query(
      `UPDATE guest_requests SET status = $1, assigned_to = $2, completed_at = ${completed_at} WHERE id = $3 RETURNING *`,
      [status, req.user.id, id]
    );
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
