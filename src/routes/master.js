const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');

// ── HOTELS ──────────────────────────────────────────────

// GET /api/hotels
router.get('/hotels', authenticate, (req, res) => {
  const hotels = db.prepare(`
    SELECT h.*,
      (SELECT COUNT(*) FROM linens WHERE hotel_id=h.id AND status != 'retired') as enrolled_linens
    FROM hotels h WHERE h.status='active' ORDER BY h.name
  `).all();
  res.json(hotels);
});

// POST /api/hotels
router.post('/hotels', authenticate, requireRole('platform_admin'), (req, res) => {
  const { name, city, rooms } = req.body;
  if (!name || !city) return res.status(400).json({ error: 'Name and city are required' });
  const id = db.generateId();
  db.prepare('INSERT INTO hotels (id,name,city,rooms) VALUES (?,?,?,?)').run(id, name, city, rooms || 0);
  res.status(201).json(db.prepare('SELECT * FROM hotels WHERE id=?').get(id));
});

// PUT /api/hotels/:id
router.put('/hotels/:id', authenticate, requireRole('platform_admin'), (req, res) => {
  const { name, city, rooms, status } = req.body;
  db.prepare('UPDATE hotels SET name=COALESCE(?,name),city=COALESCE(?,city),rooms=COALESCE(?,rooms),status=COALESCE(?,status) WHERE id=?')
    .run(name, city, rooms, status, req.params.id);
  res.json(db.prepare('SELECT * FROM hotels WHERE id=?').get(req.params.id));
});

// ── LAUNDRY PROVIDERS ────────────────────────────────────

// GET /api/laundry-providers
router.get('/laundry-providers', authenticate, (req, res) => {
  const providers = db.prepare(`
    SELECT lp.*,
      (SELECT COUNT(*) FROM batches WHERE laundry_provider_id=lp.id AND status IN ('dispatched','at_laundry','in_transit')) as active_batches,
      (SELECT COUNT(*) FROM batch_items bi JOIN batches b ON bi.batch_id=b.id WHERE b.laundry_provider_id=lp.id AND b.status IN ('dispatched','at_laundry','in_transit')) as current_items
    FROM laundry_providers lp WHERE lp.status='active' ORDER BY lp.name
  `).all();
  res.json(providers);
});

// POST /api/laundry-providers
router.post('/laundry-providers', authenticate, requireRole('platform_admin','hotel_admin'), (req, res) => {
  const { name, contact, sla_hours } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = db.generateId();
  db.prepare('INSERT INTO laundry_providers (id,name,contact,sla_hours) VALUES (?,?,?,?)').run(id, name, contact || '', sla_hours || 24);
  res.status(201).json(db.prepare('SELECT * FROM laundry_providers WHERE id=?').get(id));
});

// PUT /api/laundry-providers/:id
router.put('/laundry-providers/:id', authenticate, requireRole('platform_admin','hotel_admin'), (req, res) => {
  const { name, contact, sla_hours, status } = req.body;
  db.prepare('UPDATE laundry_providers SET name=COALESCE(?,name),contact=COALESCE(?,contact),sla_hours=COALESCE(?,sla_hours),status=COALESCE(?,status) WHERE id=?')
    .run(name, contact, sla_hours, status, req.params.id);
  res.json(db.prepare('SELECT * FROM laundry_providers WHERE id=?').get(req.params.id));
});

// ── LINEN TYPES ──────────────────────────────────────────

// GET /api/linen-types
router.get('/linen-types', authenticate, (req, res) => {
  const types = db.prepare('SELECT * FROM linen_types ORDER BY category, name').all();
  res.json(types);
});

// POST /api/linen-types
router.post('/linen-types', authenticate, requireRole('platform_admin'), (req, res) => {
  const { name, category, max_washes, warning_pct, action_at_limit, billing_rate } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'Name and category are required' });
  const id = db.generateId();
  db.prepare('INSERT INTO linen_types (id,name,category,max_washes,warning_pct,action_at_limit,billing_rate) VALUES (?,?,?,?,?,?,?)')
    .run(id, name, category, max_washes || 100, warning_pct || 90, action_at_limit || 'flag', billing_rate || 0);
  res.status(201).json(db.prepare('SELECT * FROM linen_types WHERE id=?').get(id));
});

// PUT /api/linen-types/:id
router.put('/linen-types/:id', authenticate, requireRole('platform_admin'), (req, res) => {
  const { name, category, max_washes, warning_pct, action_at_limit, billing_rate } = req.body;
  db.prepare(`UPDATE linen_types SET
    name=COALESCE(?,name), category=COALESCE(?,category), max_washes=COALESCE(?,max_washes),
    warning_pct=COALESCE(?,warning_pct), action_at_limit=COALESCE(?,action_at_limit), billing_rate=COALESCE(?,billing_rate)
    WHERE id=?`).run(name, category, max_washes, warning_pct, action_at_limit, billing_rate, req.params.id);
  res.json(db.prepare('SELECT * FROM linen_types WHERE id=?').get(req.params.id));
});

module.exports = router;
