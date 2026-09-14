const express = require('express');
const pool = require('../config/db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Check in a guest — creates a booking and marks the room occupied
router.post('/checkin', authenticateToken, requireRole('reception'), async (req, res) => {
  const { guest_name, guest_phone, room_id } = req.body;
  if (!guest_name || !room_id) {
    return res.status(400).json({ success: false, error: 'guest_name and room_id are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roomCheck = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [room_id]);
    if (roomCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    if (roomCheck.rows[0].status === 'occupied') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Room is already occupied' });
    }

    const booking = await client.query(
      'INSERT INTO bookings (guest_name, guest_phone, room_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [guest_name, guest_phone, room_id, req.user.id]
    );

    const room = await client.query(
      "UPDATE rooms SET status = 'occupied', updated_by = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [req.user.id, room_id]
    );

    await client.query('COMMIT');

    await logAudit('bookings', booking.rows[0].id, 'create', req.user.id, null, booking.rows[0]);
    await logAudit('rooms', room_id, 'update', req.user.id, roomCheck.rows[0], room.rows[0]);

    res.json({ success: true, booking: booking.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Check out a guest — settles all pending room charges, closes the booking, marks room for cleaning
router.post('/:id/checkout', authenticateToken, requireRole('reception'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bookingCheck = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
    if (bookingCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    const booking = bookingCheck.rows[0];
    if (booking.status === 'checked_out') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Booking is already checked out' });
    }

    // Settle any pending room charges
    await client.query(
      "UPDATE orders SET payment_status = 'completed', order_status = 'completed', completed_at = NOW() WHERE room_id = $1 AND payment_method = 'room_charge' AND payment_status = 'pending'",
      [booking.room_id]
    );

    const updatedBooking = await client.query(
      "UPDATE bookings SET status = 'checked_out', check_out = NOW() WHERE id = $1 RETURNING *",
      [id]
    );

    const roomOld = await client.query('SELECT * FROM rooms WHERE id = $1', [booking.room_id]);
    const updatedRoom = await client.query(
      "UPDATE rooms SET status = 'cleaning', updated_by = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [req.user.id, booking.room_id]
    );

    await client.query('COMMIT');

    await logAudit('bookings', id, 'update', req.user.id, booking, updatedBooking.rows[0]);
    await logAudit('rooms', booking.room_id, 'update', req.user.id, roomOld.rows[0], updatedRoom.rows[0]);

    res.json({ success: true, booking: updatedBooking.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Get all active bookings (who's currently checked in)
router.get('/active', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT bookings.*, rooms.room_number
       FROM bookings JOIN rooms ON bookings.room_id = rooms.id
       WHERE bookings.status = 'active'
       ORDER BY bookings.check_in DESC`
    );
    res.json({ success: true, bookings: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
