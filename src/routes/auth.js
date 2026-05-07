const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { authenticate, JWT_SECRET } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email=? AND status=?').get(email.toLowerCase().trim(), 'active');
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), user.id);

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '12h' });
  const hotel = user.hotel_id ? db.prepare('SELECT id,name,city FROM hotels WHERE id=?').get(user.hotel_id) : null;

  db.prepare('INSERT INTO audit_log (id,user_id,action,details,ip_address) VALUES (?,?,?,?,?)').run(
    db.generateId(), user.id, 'login', `User logged in`, req.ip
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, hotel_id: user.hotel_id, hotel }
  });
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const hotel = req.user.hotel_id
    ? db.prepare('SELECT id,name,city FROM hotels WHERE id=?').get(req.user.hotel_id)
    : null;
  res.json({ ...req.user, hotel });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.user.id);
  res.json({ message: 'Password changed successfully' });
});

module.exports = router;
