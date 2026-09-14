const express = require('express');
const pool = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const { lowStockAlert } = require('../utils/notify');

const router = express.Router();

// Get inventory (scoped to user's department, owner sees all)
router.get('/', authenticateToken, async (req, res) => {
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
router.post('/', authenticateToken, async (req, res) => {
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
router.post('/bulk', authenticateToken, async (req, res) => {
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
router.get('/alerts', authenticateToken, async (req, res) => {
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
router.put('/:id', authenticateToken, async (req, res) => {
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
      await lowStockAlert(item);
    }
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
