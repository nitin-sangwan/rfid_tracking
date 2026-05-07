const jwt = require('jsonwebtoken');
const db = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'linentrack-dev-secret-change-in-production';

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,name,email,role,hotel_id,status FROM users WHERE id=?').get(payload.userId);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function hotelScope(req, res, next) {
  // Platform admin can see all hotels; others scoped to their hotel
  if (req.user.role === 'platform_admin') return next();
  const hotelId = req.query.hotel_id || req.body?.hotel_id || req.params?.hotel_id;
  if (hotelId && hotelId !== req.user.hotel_id) {
    return res.status(403).json({ error: 'Access denied to this hotel' });
  }
  if (!req.query.hotel_id) req.query.hotel_id = req.user.hotel_id;
  next();
}

module.exports = { authenticate, requireRole, hotelScope, JWT_SECRET };
