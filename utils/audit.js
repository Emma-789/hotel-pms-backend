const pool = require('../config/db');

// Log an audit entry. Never throws - a failed audit write shouldn't break the request.
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

module.exports = { logAudit };
