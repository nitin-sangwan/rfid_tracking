const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authenticate, hotelScope } = require('../middleware/auth');

// GET /api/batches
router.get('/', authenticate, hotelScope, (req, res) => {
  const { hotel_id, status, page = 1, page_size = 50 } = req.query;
  let where = ['1=1'];
  const params = [];
  if (hotel_id) { where.push('b.hotel_id=?'); params.push(hotel_id); }
  if (status) { where.push('b.status=?'); params.push(status); }

  const offset = (parseInt(page) - 1) * parseInt(page_size);
  const total = db.prepare(`SELECT COUNT(*) as c FROM batches b WHERE ${where.join(' AND ')}`).get(params).c;
  const rows = db.prepare(`
    SELECT b.*, h.name as hotel_name, lp.name as laundry_name,
      (SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id) as total_items,
      (SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id AND returned_at IS NOT NULL) as returned_items,
      u.name as created_by_name
    FROM batches b
    JOIN hotels h ON b.hotel_id=h.id
    JOIN laundry_providers lp ON b.laundry_provider_id=lp.id
    LEFT JOIN users u ON b.created_by=u.id
    WHERE ${where.join(' AND ')}
    ORDER BY b.dispatched_at DESC
    LIMIT ? OFFSET ?
  `).all([...params, parseInt(page_size), offset]);

  res.json({ data: rows, total, page: parseInt(page), page_size: parseInt(page_size) });
});

// GET /api/batches/:id
router.get('/:id', authenticate, (req, res) => {
  const batch = db.prepare(`
    SELECT b.*, h.name as hotel_name, lp.name as laundry_name, lp.sla_hours,
      (SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id) as total_items,
      (SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id AND returned_at IS NOT NULL) as returned_items
    FROM batches b
    JOIN hotels h ON b.hotel_id=h.id
    JOIN laundry_providers lp ON b.laundry_provider_id=lp.id
    WHERE b.id=?
  `).get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const items = db.prepare(`
    SELECT bi.*, l.linen_code, l.rfid_tag, lt.name as type_name
    FROM batch_items bi
    JOIN linens l ON bi.linen_id=l.id
    JOIN linen_types lt ON l.linen_type_id=lt.id
    WHERE bi.batch_id=?
    ORDER BY l.linen_code
  `).all(req.params.id);

  const breakdown = db.prepare(`
    SELECT lt.name as type_name, COUNT(*) as count,
      SUM(CASE WHEN bi.returned_at IS NOT NULL THEN 1 ELSE 0 END) as returned
    FROM batch_items bi
    JOIN linens l ON bi.linen_id=l.id
    JOIN linen_types lt ON l.linen_type_id=lt.id
    WHERE bi.batch_id=?
    GROUP BY lt.id
  `).all(req.params.id);

  res.json({ ...batch, items, breakdown });
});

// POST /api/batches — create dispatch
router.post('/', authenticate, (req, res) => {
  const { hotel_id, laundry_provider_id, linen_ids, sla_hours, notes } = req.body;
  if (!hotel_id || !laundry_provider_id || !Array.isArray(linen_ids) || !linen_ids.length) {
    return res.status(400).json({ error: 'hotel_id, laundry_provider_id and linen_ids[] required' });
  }

  const provider = db.prepare('SELECT * FROM laundry_providers WHERE id=?').get(laundry_provider_id);
  if (!provider) return res.status(400).json({ error: 'Laundry provider not found' });

  const now = new Date();
  const expected = new Date(now.getTime() + (sla_hours || provider.sla_hours) * 3600000);

  // Generate batch code
  const lastBatch = db.prepare("SELECT batch_code FROM batches ORDER BY rowid DESC LIMIT 1").get();
  let lastNum = 1000;
  if (lastBatch) {
    const m = lastBatch.batch_code.match(/(\d+)$/);
    if (m) lastNum = parseInt(m[1]);
  }
  const batch_code = `BCH-${now.getFullYear()}-${String(lastNum + 1).padStart(4, '0')}`;

  const batchId = db.generateId();

  const txn = db.transaction(() => {
    db.prepare(`INSERT INTO batches (id,batch_code,hotel_id,laundry_provider_id,dispatched_at,expected_return_at,status,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(batchId, batch_code, hotel_id, laundry_provider_id, now.toISOString(), expected.toISOString(), 'dispatched', notes || null, req.user.id);

    const insertItem = db.prepare('INSERT INTO batch_items (id,batch_id,linen_id,wash_count_before) VALUES (?,?,?,?)');
    for (const linenId of linen_ids) {
      const linen = db.prepare('SELECT * FROM linens WHERE id=?').get(linenId);
      if (!linen) continue;
      insertItem.run(db.generateId(), batchId, linenId, linen.wash_count);
      db.prepare("UPDATE linens SET status='at_laundry' WHERE id=?").run(linenId);
    }

    db.prepare("UPDATE batches SET status='dispatched' WHERE id=?").run(batchId);
  });
  txn();

  db.prepare('INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(db.generateId(), req.user.id, 'create_batch', 'batch', batchId, `Dispatched ${linen_ids.length} items to ${provider.name}`);

  const batch = db.prepare('SELECT b.*,h.name as hotel_name,lp.name as laundry_name FROM batches b JOIN hotels h ON b.hotel_id=h.id JOIN laundry_providers lp ON b.laundry_provider_id=lp.id WHERE b.id=?').get(batchId);
  res.status(201).json(batch);
});

// POST /api/batches/:id/acknowledge — QR scan by laundry
router.post('/:id/acknowledge', (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  db.prepare("UPDATE batches SET qr_acknowledged_at=?, status='at_laundry' WHERE id=?")
    .run(new Date().toISOString(), req.params.id);
  res.json({ message: 'Batch acknowledged', batch_code: batch.batch_code });
});

// POST /api/batches/:id/return — process return scan
router.post('/:id/return', authenticate, (req, res) => {
  const { returned_items } = req.body;
  // returned_items: [{linen_id, return_status}]
  if (!Array.isArray(returned_items)) return res.status(400).json({ error: 'returned_items[] required' });

  const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    for (const item of returned_items) {
      const bi = db.prepare('SELECT * FROM batch_items WHERE batch_id=? AND linen_id=?').get(req.params.id, item.linen_id);
      if (!bi) continue;

      const isRewash = item.return_status === 'rewash';
      const shouldRetire = item.return_status === 'retired';

      db.prepare('UPDATE batch_items SET returned_at=?,return_status=?,rewash=? WHERE batch_id=? AND linen_id=?')
        .run(now, item.return_status || 'good', isRewash ? 1 : 0, req.params.id, item.linen_id);

      const newWash = bi.wash_count_before + 1;
      const newStatus = shouldRetire ? 'retired' : 'in_house';
      const retiredAt = shouldRetire ? now : null;
      db.prepare('UPDATE linens SET wash_count=?,status=?,retired_at=? WHERE id=?')
        .run(newWash, newStatus, retiredAt, item.linen_id);
    }

    // Check if all items returned
    const total = db.prepare('SELECT COUNT(*) as c FROM batch_items WHERE batch_id=?').get(req.params.id).c;
    const returned = db.prepare('SELECT COUNT(*) as c FROM batch_items WHERE batch_id=? AND returned_at IS NOT NULL').get(req.params.id).c;
    const newStatus = returned >= total ? 'returned' : 'partially_returned';
    const returnedAt = returned >= total ? now : null;
    db.prepare('UPDATE batches SET status=?,returned_at=? WHERE id=?').run(newStatus, returnedAt, req.params.id);
  });
  txn();

  db.prepare('INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(db.generateId(), req.user.id, 'return_scan', 'batch', req.params.id, `Returned ${returned_items.length} items`);

  const updated = db.prepare(`SELECT b.*,
    (SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id) as total_items,
    (SELECT COUNT(*) FROM batch_items WHERE batch_id=b.id AND returned_at IS NOT NULL) as returned_items
    FROM batches b WHERE b.id=?`).get(req.params.id);
  res.json(updated);
});

// Mark overdue batches (called periodically or on-demand)
router.post('/check-overdue', authenticate, (req, res) => {
  const now = new Date().toISOString();
  const result = db.prepare(`UPDATE batches SET status='overdue'
    WHERE status IN ('dispatched','acknowledged','at_laundry','in_transit')
    AND expected_return_at < ?`).run(now);
  res.json({ updated: result.changes });
});

module.exports = router;
