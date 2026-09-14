const express = require('express');
const pool = require('../config/db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendOwnerAlert, lowStockAlert } = require('../utils/notify');

const router = express.Router();

// Create an order (request + payment combined). If inventory_item_id is
// provided, the order is linked to a stock item and that quantity is
// deducted from inventory as part of the same transaction — so an order
// can never be recorded without also reflecting the stock it used.
router.post('/', authenticateToken, async (req, res) => {
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
      await lowStockAlert(stockItem);
    }

    if (payment_status === 'failed') {
      await sendOwnerAlert(
        '⚠️ Order Payment Failed - Hotel PMS',
        `Order for ${guest_identifier || 'room ' + room_id}: payment of ₦${amount} via ${payment_method} failed.\n\nDetails: ${description}`
      );
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
router.get('/', authenticateToken, async (req, res) => {
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
router.put('/:id', authenticateToken, async (req, res) => {
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

module.exports = router;
