const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authenticate, requireRole, hotelScope } = require('../middleware/auth');

// ══════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════

// GET /api/reports/dashboard — KPIs
router.get('/reports/dashboard', authenticate, hotelScope, (req, res) => {
  const { hotel_id } = req.query;
  const h = hotel_id ? 'AND hotel_id=?' : '';
  const p = hotel_id ? [hotel_id] : [];

  const total = db.prepare(`SELECT COUNT(*) as c FROM linens WHERE status != 'retired' ${h}`).get(p).c;
  const atLaundry = db.prepare(`SELECT COUNT(*) as c FROM linens WHERE status='at_laundry' ${h}`).get(p).c;
  const missing = db.prepare(`SELECT COUNT(*) as c FROM linens WHERE status='missing' ${h}`).get(p).c;
  const retired = db.prepare(`SELECT COUNT(*) as c FROM linens WHERE status='retired' ${h}`).get(p).c;

  const turnaround = db.prepare(`
    SELECT AVG((julianday(returned_at) - julianday(dispatched_at)) * 24) as avg_hrs
    FROM batches WHERE status='returned' AND returned_at IS NOT NULL
    ${hotel_id ? 'AND hotel_id=?' : ''}
  `).get(p);

  const lifecycleWarn = db.prepare(`
    SELECT COUNT(*) as c FROM linens l
    JOIN linen_types lt ON l.linen_type_id=lt.id
    WHERE CAST(l.wash_count AS REAL) / lt.max_washes >= lt.warning_pct/100.0
    AND l.status != 'retired' ${h}
  `).get(p).c;

  const activeBatches = db.prepare(`
    SELECT b.*, h.name as hotel_name, lp.name as laundry_name,
      (SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id) as total_items
    FROM batches b JOIN hotels h ON b.hotel_id=h.id JOIN laundry_providers lp ON b.laundry_provider_id=lp.id
    WHERE b.status IN ('dispatched','acknowledged','at_laundry','in_transit','overdue')
    ${hotel_id ? 'AND b.hotel_id=?' : ''}
    ORDER BY b.dispatched_at DESC LIMIT 10
  `).all(p);

  const stockByType = db.prepare(`
    SELECT lt.name as type_name, lt.category,
      COUNT(*) as total,
      SUM(CASE WHEN l.status='in_house' THEN 1 ELSE 0 END) as in_house,
      SUM(CASE WHEN l.status='at_laundry' THEN 1 ELSE 0 END) as at_laundry
    FROM linens l JOIN linen_types lt ON l.linen_type_id=lt.id
    WHERE l.status != 'retired' ${h}
    GROUP BY l.linen_type_id ORDER BY lt.category, lt.name
  `).all(p);

  const laundryUtil = db.prepare(`
    SELECT lp.name, COUNT(bi.id) as items
    FROM batches b JOIN batch_items bi ON bi.batch_id=b.id
    JOIN laundry_providers lp ON b.laundry_provider_id=lp.id
    WHERE b.status IN ('at_laundry','dispatched','in_transit') ${hotel_id ? 'AND b.hotel_id=?' : ''}
    GROUP BY lp.id ORDER BY items DESC
  `).all(p);

  res.json({
    totals: { total, at_laundry: atLaundry, missing, retired, lifecycle_warning: lifecycleWarn },
    avg_turnaround_hours: turnaround?.avg_hrs ? Math.round(turnaround.avg_hrs * 10) / 10 : null,
    active_batches: activeBatches,
    stock_by_type: stockByType,
    laundry_utilization: laundryUtil
  });
});

// GET /api/reports/stock
router.get('/reports/stock', authenticate, hotelScope, (req, res) => {
  const { hotel_id } = req.query;
  const where = hotel_id ? 'AND l.hotel_id=?' : '';
  const params = hotel_id ? [hotel_id] : [];

  const byHotelType = db.prepare(`
    SELECT h.name as hotel_name, lt.name as type_name,
      COUNT(*) as total,
      SUM(CASE WHEN l.status='in_house' THEN 1 ELSE 0 END) as in_house,
      SUM(CASE WHEN l.status='at_laundry' THEN 1 ELSE 0 END) as at_laundry,
      SUM(CASE WHEN l.status='retired' THEN 1 ELSE 0 END) as retired
    FROM linens l JOIN hotels h ON l.hotel_id=h.id JOIN linen_types lt ON l.linen_type_id=lt.id
    WHERE 1=1 ${where}
    GROUP BY l.hotel_id, l.linen_type_id
    ORDER BY h.name, lt.category, lt.name
  `).all(params);

  res.json(byHotelType);
});

// GET /api/reports/turnaround
router.get('/reports/turnaround', authenticate, hotelScope, (req, res) => {
  const { hotel_id } = req.query;
  const where = hotel_id ? 'AND b.hotel_id=?' : '';
  const params = hotel_id ? [hotel_id] : [];

  const byProvider = db.prepare(`
    SELECT lp.name as provider,
      COUNT(*) as total_batches,
      SUM(CASE WHEN b.returned_at <= b.expected_return_at THEN 1 ELSE 0 END) as on_time,
      AVG(CASE WHEN b.returned_at IS NOT NULL
        THEN (julianday(b.returned_at)-julianday(b.dispatched_at))*24 END) as avg_hours,
      SUM(CASE WHEN b.status='overdue' THEN 1 ELSE 0 END) as overdue
    FROM batches b JOIN laundry_providers lp ON b.laundry_provider_id=lp.id
    WHERE 1=1 ${where}
    GROUP BY lp.id ORDER BY avg_hours
  `).all(params);

  res.json(byProvider.map(r => ({
    ...r,
    avg_hours: r.avg_hours ? Math.round(r.avg_hours * 10) / 10 : null,
    on_time_pct: r.total_batches > 0 ? Math.round((r.on_time / r.total_batches) * 100) : null
  })));
});

// ══════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════

// GET /api/alerts
router.get('/alerts', authenticate, hotelScope, (req, res) => {
  const { hotel_id, resolved = '0' } = req.query;
  let where = ['1=1'];
  const params = [];
  if (hotel_id) { where.push('a.hotel_id=?'); params.push(hotel_id); }
  where.push('a.resolved=?'); params.push(parseInt(resolved));

  const alerts = db.prepare(`
    SELECT a.*, h.name as hotel_name
    FROM alerts a LEFT JOIN hotels h ON a.hotel_id=h.id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE a.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, a.created_at DESC
  `).all(params);
  res.json(alerts);
});

// POST /api/alerts/:id/resolve
router.post('/alerts/:id/resolve', authenticate, (req, res) => {
  db.prepare('UPDATE alerts SET resolved=1,resolved_at=?,resolved_by=? WHERE id=?')
    .run(new Date().toISOString(), req.user.id, req.params.id);
  res.json({ message: 'Alert resolved' });
});

// ══════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════
const bcrypt = require('bcryptjs');

// GET /api/users
router.get('/users', authenticate, requireRole('platform_admin','hotel_admin'), (req, res) => {
  let where = "u.status='active'";
  const params = [];
  if (req.user.role === 'hotel_admin') { where += ' AND u.hotel_id=?'; params.push(req.user.hotel_id); }

  const users = db.prepare(`
    SELECT u.id,u.name,u.email,u.role,u.hotel_id,u.status,u.last_login,u.created_at,
      h.name as hotel_name
    FROM users u LEFT JOIN hotels h ON u.hotel_id=h.id
    WHERE ${where} ORDER BY u.name
  `).all(params);
  res.json(users);
});

// POST /api/users
router.post('/users', authenticate, requireRole('platform_admin','hotel_admin'), (req, res) => {
  const { name, email, password, role, hotel_id } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password, role required' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const id = db.generateId();
  db.prepare('INSERT INTO users (id,name,email,password_hash,role,hotel_id) VALUES (?,?,?,?,?,?)')
    .run(id, name, email.toLowerCase(), bcrypt.hashSync(password, 10), role, hotel_id || null);
  res.status(201).json(db.prepare('SELECT id,name,email,role,hotel_id,status FROM users WHERE id=?').get(id));
});

// PUT /api/users/:id
router.put('/users/:id', authenticate, requireRole('platform_admin','hotel_admin'), (req, res) => {
  const { name, role, hotel_id, status, password } = req.body;
  if (password) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.params.id);
  }
  db.prepare(`UPDATE users SET name=COALESCE(?,name),role=COALESCE(?,role),hotel_id=COALESCE(?,hotel_id),status=COALESCE(?,status) WHERE id=?`)
    .run(name, role, hotel_id, status, req.params.id);
  res.json(db.prepare('SELECT id,name,email,role,hotel_id,status FROM users WHERE id=?').get(req.params.id));
});

// ══════════════════════════════════════════════
// SUPPORT TICKETS
// ══════════════════════════════════════════════

// GET /api/support
router.get('/support', authenticate, hotelScope, (req, res) => {
  const { hotel_id, status } = req.query;
  let where = ['1=1'];
  const params = [];
  if (hotel_id) { where.push('t.hotel_id=?'); params.push(hotel_id); }
  if (status) { where.push('t.status=?'); params.push(status); }

  const tickets = db.prepare(`
    SELECT t.*, u.name as created_by_name, h.name as hotel_name
    FROM support_tickets t LEFT JOIN users u ON t.created_by=u.id LEFT JOIN hotels h ON t.hotel_id=h.id
    WHERE ${where.join(' AND ')} ORDER BY
    CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.created_at DESC
  `).all(params);
  res.json(tickets);
});

// POST /api/support
router.post('/support', authenticate, (req, res) => {
  const { issue_type, priority, description, batch_id, linen_id } = req.body;
  if (!issue_type || !description) return res.status(400).json({ error: 'issue_type and description required' });

  const lastTicket = db.prepare("SELECT ticket_code FROM support_tickets ORDER BY rowid DESC LIMIT 1").get();
  let lastNum = 1000;
  if (lastTicket) { const m = lastTicket.ticket_code.match(/(\d+)$/); if (m) lastNum = parseInt(m[1]); }
  const ticket_code = `TKT-${new Date().getFullYear()}-${String(lastNum + 1).padStart(4, '0')}`;

  const id = db.generateId();
  db.prepare(`INSERT INTO support_tickets (id,ticket_code,hotel_id,created_by,issue_type,priority,description,batch_id,linen_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, ticket_code, req.user.hotel_id, req.user.id, issue_type, priority || 'medium', description, batch_id || null, linen_id || null);

  res.status(201).json(db.prepare('SELECT * FROM support_tickets WHERE id=?').get(id));
});

// PUT /api/support/:id
router.put('/support/:id', authenticate, requireRole('platform_admin','hotel_admin'), (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE support_tickets SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), req.params.id);
  res.json(db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id));
});

module.exports = router;
