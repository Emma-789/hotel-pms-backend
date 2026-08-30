require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

const app = express();
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

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
// Register a new user (for initial setup - owner creates staff accounts)
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, role, name, phone } = req.body;
    const password_hash = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role, name, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, name',
      [email, password_hash, role, name, phone]
    );
    
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ 
      success: true, 
      token, 
      user: { id: user.id, email: user.email, role: user.role, name: user.name } 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// Middleware to verify login token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ success: false, error: 'No token provided' });
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Middleware to restrict routes by role. Owner always has access.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (req.user.role === 'owner') return next(); // owner sees everything
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied for your role' });
    }
    next();
  };
}

// Get inventory (scoped to user's department, owner sees all)
app.get('/api/inventory', authenticateToken, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'owner') {
      result = await pool.query('SELECT * FROM inventory ORDER BY department, item_name');
    } else {
      result = await pool.query('SELECT * FROM inventory WHERE department = $1 ORDER BY item_name', [req.user.role]);
    }
    res.json({ success: true, inventory: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add new inventory item (goes into your own department unless owner specifies one)
app.post('/api/inventory', authenticateToken, async (req, res) => {
  try {
    const { item_name, quantity, min_quantity, category } = req.body;
    const department = req.user.role === 'owner' ? (req.body.department || 'reception') : req.user.role;
    const result = await pool.query(
      'INSERT INTO inventory (item_name, quantity, min_quantity, category, department, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [item_name, quantity, min_quantity, category, department, req.user.id]
    );
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add many inventory items at once (used by the "paste a list" bulk-add flow).
// All rows go into the same department, inserted in one transaction so a
// bad row doesn't leave the list half-added.
app.post('/api/inventory/bulk', authenticateToken, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'items must be a non-empty array' });
  }

  const department = req.user.role === 'owner' ? (req.body.department || 'reception') : req.user.role;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];
    for (const item of items) {
      if (!item.item_name || !item.item_name.trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Every row needs an item name' });
      }
      const result = await client.query(
        'INSERT INTO inventory (item_name, quantity, min_quantity, category, department, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [item.item_name.trim(), Number(item.quantity) || 0, Number(item.min_quantity) || 0, item.category || null, department, req.user.id]
      );
      inserted.push(result.rows[0]);
    }
    await client.query('COMMIT');
    res.json({ success: true, items: inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Get low-stock items (quantity at or below min_quantity), scoped to department
app.get('/api/inventory/alerts', authenticateToken, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'owner') {
      result = await pool.query(
        'SELECT * FROM inventory WHERE quantity <= min_quantity ORDER BY department, item_name'
      );
    } else {
      result = await pool.query(
        'SELECT * FROM inventory WHERE department = $1 AND quantity <= min_quantity ORDER BY item_name',
        [req.user.role]
      );
    }
    res.json({ success: true, alerts: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update inventory item (only your own department, unless owner)
app.put('/api/inventory/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    const check = await pool.query('SELECT department FROM inventory WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ success: false, error: 'Item not found' });
    if (req.user.role !== 'owner' && check.rows[0].department !== req.user.role) {
      return res.status(403).json({ success: false, error: 'Access denied for your department' });
    }

    const result = await pool.query(
      'UPDATE inventory SET quantity = $1, last_updated = NOW(), updated_by = $2 WHERE id = $3 RETURNING *',
      [quantity, req.user.id, id]
    );
    const item = result.rows[0];

    // If stock just dropped to or below the minimum, email the owner
    if (item.min_quantity !== null && item.quantity <= item.min_quantity) {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.EMAIL_USER,
          subject: `⚠️ Low Stock Alert - ${item.item_name}`,
          text: `${item.item_name} (${item.department}) is at ${item.quantity}, at or below the minimum of ${item.min_quantity}.`
        });
      } catch (emailErr) {
        console.log('Low stock email failed:', emailErr.message);
      }
    }
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// Create guest request
app.post('/api/guest-requests', authenticateToken, requireRole('reception'), async (req, res) => {
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
app.get('/api/guest-requests', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guest_requests ORDER BY created_at DESC');
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update guest request status
app.put('/api/guest-requests/:id', authenticateToken, requireRole('reception'), async (req, res) => {
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

// Record a payment (cash, card, or transfer)
app.post('/api/payments', authenticateToken, async (req, res) => {
  try {
    const { amount, payment_method, room_number, status, reference_number, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO payments (amount, payment_method, room_number, status, reference_number, notes, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [amount, payment_method, room_number, status || 'completed', reference_number, notes, req.user.id]
    );
    
    const payment = result.rows[0];
    
    // If payment failed, create an alert
       // If payment failed, create an alert AND send email
if (status === 'failed') {
  await pool.query(
    'INSERT INTO payment_alerts (payment_id, alert_type, description) VALUES ($1, $2, $3)',
    [payment.id, 'failed', `Payment of ${amount} via ${payment_method} failed for room ${room_number}`]
  );
  
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // change to owner's real email later
      subject: '⚠️ Payment Failed Alert - Hotel PMS',
      text: `A payment of ₦${amount} via ${payment_method} failed for room ${room_number}.\n\nPlease check the system for details.`
    });
  } catch (emailErr) {
    console.log('Email failed to send:', emailErr.message);
  }
}
    res.json({ success: true, payment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all payments
app.get('/api/payments', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payments ORDER BY created_at DESC');
    res.json({ success: true, payments: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// Helper: log an audit entry
async function logAudit(tableName, recordId, action, userId, oldValue, newValue) {
  try {
    await pool.query(
      'INSERT INTO audit_log (table_name, record_id, action, changed_by, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
      [tableName, recordId, action, userId, JSON.stringify(oldValue), JSON.stringify(newValue)]
    );
  } catch (err) {
    console.log('Audit log failed:', err.message);
  }
}

// Create an order (request + payment combined). If inventory_item_id is
// provided, the order is linked to a stock item and that quantity is
// deducted from inventory as part of the same transaction — so an order
// can never be recorded without also reflecting the stock it used.
app.post('/api/orders', authenticateToken, async (req, res) => {
  const {
    guest_identifier, description, amount, payment_method, payment_status, room_id,
    inventory_item_id, item_quantity
  } = req.body;
  let { order_type } = req.body;

  // Bar/kitchen staff can only create orders for their own department
  if (req.user.role === 'bar' || req.user.role === 'kitchen') {
    order_type = req.user.role;
  } else if (order_type !== 'bar' && order_type !== 'kitchen') {
    return res.status(400).json({ success: false, error: "order_type must be 'bar' or 'kitchen'" });
  }

  // Order needs either a room (room charge) or a walk-in identifier
  if (!room_id && !guest_identifier) {
    return res.status(400).json({ success: false, error: 'Provide either room_id or guest_identifier' });
  }
  if (room_id && payment_method !== 'room_charge') {
    return res.status(400).json({ success: false, error: "payment_method must be 'room_charge' when room_id is set" });
  }
  if (inventory_item_id && (!item_quantity || item_quantity <= 0)) {
    return res.status(400).json({ success: false, error: 'item_quantity must be greater than 0 when an inventory item is selected' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let stockItem = null;
    if (inventory_item_id) {
      // Lock the row so two simultaneous orders can't both pass the stock check
      const invResult = await client.query('SELECT * FROM inventory WHERE id = $1 FOR UPDATE', [inventory_item_id]);
      if (invResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Inventory item not found' });
      }
      stockItem = invResult.rows[0];

      if (stockItem.department !== order_type) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: `That item belongs to ${stockItem.department}, not ${order_type}` });
      }
      if (stockItem.quantity < item_quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Not enough stock for ${stockItem.item_name} (have ${stockItem.quantity}, need ${item_quantity})`
        });
      }

      const updatedInv = await client.query(
        'UPDATE inventory SET quantity = quantity - $1, last_updated = NOW(), updated_by = $2 WHERE id = $3 RETURNING *',
        [item_quantity, req.user.id, inventory_item_id]
      );
      stockItem = updatedInv.rows[0];
    }

    const result = await client.query(
      `INSERT INTO orders
         (guest_identifier, order_type, description, amount, payment_method, payment_status, created_by, room_id, inventory_item_id, item_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        guest_identifier || null, order_type, description, amount, payment_method,
        payment_status || 'pending', req.user.id, room_id || null,
        inventory_item_id || null, inventory_item_id ? item_quantity : null
      ]
    );
    const order = result.rows[0];

    await client.query('COMMIT');

    await logAudit('orders', order.id, 'create', req.user.id, null, order);

    // Low-stock email, same threshold check used on manual inventory updates
    if (stockItem && stockItem.min_quantity !== null && stockItem.quantity <= stockItem.min_quantity) {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.EMAIL_USER,
          subject: `⚠️ Low Stock Alert - ${stockItem.item_name}`,
          text: `${stockItem.item_name} (${stockItem.department}) is at ${stockItem.quantity}, at or below the minimum of ${stockItem.min_quantity}.`
        });
      } catch (emailErr) {
        console.log('Low stock email failed:', emailErr.message);
      }
    }

    if (payment_status === 'failed') {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.EMAIL_USER,
          subject: '⚠️ Order Payment Failed - Hotel PMS',
          text: `Order for ${guest_identifier || 'room ' + room_id}: payment of ₦${amount} via ${payment_method} failed.\n\nDetails: ${description}`
        });
      } catch (emailErr) {
        console.log('Email failed:', emailErr.message);
      }
    }

    res.json({ success: true, order });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Get orders (bar/kitchen see only their own; reception & owner see all) — includes room number
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const baseQuery = `
      SELECT orders.*, rooms.room_number
      FROM orders
      LEFT JOIN rooms ON orders.room_id = rooms.id
    `;
    let result;
    if (req.user.role === 'bar' || req.user.role === 'kitchen') {
      result = await pool.query(`${baseQuery} WHERE orders.order_type = $1 ORDER BY orders.created_at DESC`, [req.user.role]);
    } else {
      result = await pool.query(`${baseQuery} ORDER BY orders.created_at DESC`);
    }
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update an order (status, payment status) — bar/kitchen can only update their own department's orders
app.put('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { order_status, payment_status } = req.body;

    const oldResult = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const oldOrder = oldResult.rows[0];
    if (!oldOrder) return res.status(404).json({ success: false, error: 'Order not found' });

    if ((req.user.role === 'bar' || req.user.role === 'kitchen') && oldOrder.order_type !== req.user.role) {
      return res.status(403).json({ success: false, error: 'Access denied for your department' });
    }

    const completed_at = order_status === 'completed' ? 'NOW()' : 'NULL';
    const result = await pool.query(
      `UPDATE orders SET order_status = $1, payment_status = $2, completed_at = ${completed_at} WHERE id = $3 RETURNING *`,
      [order_status, payment_status, id]
    );
    const updatedOrder = result.rows[0];
    await logAudit('orders', id, 'update', req.user.id, oldOrder, updatedOrder);

    res.json({ success: true, order: updatedOrder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get a room's outstanding charges (pending room_charge orders) — for checkout
app.get('/api/rooms/:id/charges', authenticateToken, requireRole('reception'), async (req, res) => {
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
app.get('/api/rooms/lookup/:room_number', authenticateToken, async (req, res) => {
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
app.get('/api/rooms', authenticateToken, requireRole('reception'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms ORDER BY room_number');
    res.json({ success: true, rooms: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a room
app.post('/api/rooms', authenticateToken, requireRole('reception'), async (req, res) => {
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
app.put('/api/rooms/:id', authenticateToken, requireRole('reception'), async (req, res) => {
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

// Get audit log (owner only)
app.get('/api/audit-log', authenticateToken, requireRole('owner'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daily summary — defaults to today, or pass ?date=YYYY-MM-DD
// Bar/kitchen see only their own orders; reception sees payments + guest requests; owner sees everything
app.get('/api/summary/daily', authenticateToken, async (req, res) => {
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

// Check in a guest — creates a booking and marks the room occupied
app.post('/api/bookings/checkin', authenticateToken, requireRole('reception'), async (req, res) => {
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
app.post('/api/bookings/:id/checkout', authenticateToken, requireRole('reception'), async (req, res) => {
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
app.get('/api/bookings/active', authenticateToken, requireRole('reception'), async (req, res) => {
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});