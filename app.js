const express = require('express');
const cors = require('cors');
const pool = require('./config/db');

const authRoutes = require('./routes/auth');
const inventoryRoutes = require('./routes/inventory');
const guestRequestRoutes = require('./routes/guestRequests');
const paymentRoutes = require('./routes/payments');
const orderRoutes = require('./routes/orders');
const roomRoutes = require('./routes/rooms');
const bookingRoutes = require('./routes/bookings');
const auditLogRoutes = require('./routes/auditLog');
const summaryRoutes = require('./routes/summary');

const app = express();
app.use(cors());
app.use(express.json());

// Test route
app.get('/', (req, res) => {
  res.send('Hotel PMS Backend is running!');
});

// Test database connection
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use('/api', authRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/guest-requests', guestRequestRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/summary', summaryRoutes);

module.exports = app;
