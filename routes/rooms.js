const express = require('express');
const pool = require('../config/db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Get a room's outstanding charges (pending room_charge orders) — for checkout
router.get('/:id/charges', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM orders WHERE room_id = $1 AND payment_method = 'room_charge' AND payment_status = 'pending' ORDER BY created_at`,
      [id]
    );
    const total = result.rows.reduce((sum, o) => sum + Number(o.amount), 0);
    res.json({ success: true, charges: result.rows, total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Look up a single room by its number — any logged-in staff can use this to
// charge an order to a room, without needing full access to the rooms list
router.get('/lookup/:room_number', authenticateToken, async (req, res) => {
  try {
    const { room_number } = req.params;
    const result = await pool.query('SELECT id, room_number, status FROM rooms WHERE room_number = $1', [room_number]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Room not found' });
    res.json({ success: true, room: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all rooms
router.get('/', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms ORDER BY room_number');
    res.json({ success: true, rooms: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a room
router.post('/', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const { room_number } = req.body;
    const result = await pool.query(
      'INSERT INTO rooms (room_number, updated_by) VALUES ($1, $2) RETURNING *',
      [room_number, req.user.id]
    );
    res.json({ success: true, room: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update room status
router.put('/:id', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const oldResult = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    const oldRoom = oldResult.rows[0];

    const result = await pool.query(
      'UPDATE rooms SET status = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, req.user.id, id]
    );
    const updatedRoom = result.rows[0];
    await logAudit('rooms', id, 'update', req.user.id, oldRoom, updatedRoom);

    res.json({ success: true, room: updatedRoom });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
