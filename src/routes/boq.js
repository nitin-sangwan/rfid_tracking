const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authenticate, requireRole, hotelScope } = require('../middleware/auth');

// GET /api/boq
router.get('/', authenticate, hotelScope, (req, res) => {
  const { hotel_id, year, status } = req.query;
  let where = ['1=1'];
  const params = [];
  if (hotel_id) { where.push('boq.hotel_id=?'); params.push(hotel_id); }
  if (year) { where.push('boq.year=?'); params.push(parseInt(year)); }
  if (status) { where.push('boq.status=?'); params.push(status); }

  const rows = db.prepare(`
    SELECT boq.*, h.name as hotel_name,
      u.name as finalized_by_name
    FROM boq
    JOIN hotels h ON boq.hotel_id=h.id
    LEFT JOIN users u ON boq.finalized_by=u.id
    WHERE ${where.join(' AND ')}
    ORDER BY boq.year DESC, boq.month DESC
  `).all(params);
  res.json(rows);
});

// GET /api/boq/:id — with line items
router.get('/:id', authenticate, (req, res) => {
  const boq = db.prepare(`
    SELECT boq.*, h.name as hotel_name, u.name as finalized_by_name
    FROM boq JOIN hotels h ON boq.hotel_id=h.id LEFT JOIN users u ON boq.finalized_by=u.id
    WHERE boq.id=?
  `).get(req.params.id);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });

  const items = db.prepare(`
    SELECT bi.*, lt.name as type_name, lt.category
    FROM boq_items bi JOIN linen_types lt ON bi.linen_type_id=lt.id
    WHERE bi.boq_id=? ORDER BY lt.category, lt.name
  `).all(req.params.id);

  res.json({ ...boq, items });
});

// POST /api/boq/generate — generate BOQ for hotel/month/year
router.post('/generate', authenticate, requireRole('platform_admin','hotel_admin','hotel_manager'), (req, res) => {
  const { hotel_id, month, year } = req.body;
  if (!hotel_id || !month || !year) return res.status(400).json({ error: 'hotel_id, month, year required' });

  // Check if already exists
  const existing = db.prepare('SELECT id FROM boq WHERE hotel_id=? AND month=? AND year=?').get(hotel_id, month, year);
  if (existing) return res.status(409).json({ error: 'BOQ already exists for this period', id: existing.id });

  // Calculate from batch_items in this period
  const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
  const endDate = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2,'0')}-01`;

  const washData = db.prepare(`
    SELECT l.linen_type_id,
      COUNT(*) as wash_count,
      SUM(bi.rewash) as rewash_count,
      COUNT(*) - SUM(bi.rewash) as billable_count,
      lt.billing_rate as rate
    FROM batch_items bi
    JOIN batches b ON bi.batch_id=b.id
    JOIN linens l ON bi.linen_id=l.id
    JOIN linen_types lt ON l.linen_type_id=lt.id
    WHERE b.hotel_id=?
      AND bi.returned_at >= ? AND bi.returned_at < ?
      AND bi.returned_at IS NOT NULL
    GROUP BY l.linen_type_id
  `).all(hotel_id, startDate, endDate);

  const totalAmount = washData.reduce((sum, r) => sum + r.billable_count * r.rate, 0);
  const boqId = db.generateId();

  const txn = db.transaction(() => {
    db.prepare('INSERT INTO boq (id,hotel_id,month,year,status,total_amount) VALUES (?,?,?,?,?,?)')
      .run(boqId, hotel_id, month, year, 'draft', totalAmount);

    const insertItem = db.prepare('INSERT INTO boq_items (id,boq_id,linen_type_id,wash_count,rewash_count,billable_count,rate,amount) VALUES (?,?,?,?,?,?,?,?)');
    for (const row of washData) {
      insertItem.run(db.generateId(), boqId, row.linen_type_id, row.wash_count, row.rewash_count || 0, row.billable_count, row.rate, row.billable_count * row.rate);
    }

    // Create alert
    db.prepare('INSERT INTO alerts (id,type,severity,hotel_id,message) VALUES (?,?,?,?,?)')
      .run(db.generateId(), 'boq_ready', 'info', hotel_id, `BOQ for ${month}/${year} is ready for review — ₹${totalAmount.toFixed(2)}`);
  });
  txn();

  db.prepare('INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(db.generateId(), req.user.id, 'generate_boq', 'boq', boqId, `Generated BOQ for ${month}/${year}`);

  const boq = db.prepare('SELECT * FROM boq WHERE id=?').get(boqId);
  res.status(201).json(boq);
});

// PUT /api/boq/:id — update status, manual corrections
router.put('/:id', authenticate, requireRole('platform_admin','hotel_admin','hotel_manager'), (req, res) => {
  const { status } = req.body;
  const boq = db.prepare('SELECT * FROM boq WHERE id=?').get(req.params.id);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  if (boq.status === 'finalized') return res.status(400).json({ error: 'Finalized BOQ cannot be modified' });

  const finalized_at = status === 'finalized' ? new Date().toISOString() : null;
  const finalized_by = status === 'finalized' ? req.user.id : null;
  db.prepare('UPDATE boq SET status=?,finalized_at=?,finalized_by=? WHERE id=?')
    .run(status, finalized_at, finalized_by, req.params.id);

  db.prepare('INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(db.generateId(), req.user.id, 'update_boq', 'boq', req.params.id, `Status changed to ${status}`);

  res.json(db.prepare('SELECT * FROM boq WHERE id=?').get(req.params.id));
});

// PUT /api/boq/:id/items/:itemId — manual line correction
router.put('/:id/items/:itemId', authenticate, requireRole('platform_admin','hotel_admin'), (req, res) => {
  const { billable_count, rate } = req.body;
  const boq = db.prepare('SELECT * FROM boq WHERE id=?').get(req.params.id);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  if (boq.status === 'finalized') return res.status(400).json({ error: 'Cannot edit finalized BOQ' });

  const amount = billable_count * rate;
  db.prepare('UPDATE boq_items SET billable_count=?,rate=?,amount=? WHERE id=? AND boq_id=?')
    .run(billable_count, rate, amount, req.params.itemId, req.params.id);

  // Recalculate total
  const total = db.prepare('SELECT SUM(amount) as t FROM boq_items WHERE boq_id=?').get(req.params.id).t || 0;
  db.prepare('UPDATE boq SET total_amount=? WHERE id=?').run(total, req.params.id);

  res.json(db.prepare('SELECT * FROM boq_items WHERE id=?').get(req.params.itemId));
});

module.exports = router;
