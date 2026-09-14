const jwt = require('jsonwebtoken');

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

module.exports = { authenticateToken, requireRole };
