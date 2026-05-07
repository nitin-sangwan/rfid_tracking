const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authenticate, hotelScope } = require('../middleware/auth');

// GET /api/linens
router.get('/', authenticate, hotelScope, (req, res) => {
  const { hotel_id, status, linen_type_id, search, page = 1, page_size = 50 } = req.query;
  let where = ['1=1'];
  const params = [];

  if (hotel_id) { where.push('l.hotel_id=?'); params.push(hotel_id); }
  if (status) { where.push('l.status=?'); params.push(status); }
  if (linen_type_id) { where.push('l.linen_type_id=?'); params.push(linen_type_id); }
  if (search) {
    where.push('(l.linen_code LIKE ? OR l.rfid_tag LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const offset = (parseInt(page) - 1) * parseInt(page_size);
  const total = db.prepare(`SELECT COUNT(*) as c FROM linens l WHERE ${where.join(' AND ')}`).get(params).c;
  const rows = db.prepare(`
    SELECT l.*, lt.name as type_name, lt.category, lt.max_washes, lt.warning_pct, lt.action_at_limit,
           h.name as hotel_name
    FROM linens l
    JOIN linen_types lt ON l.linen_type_id = lt.id
    JOIN hotels h ON l.hotel_id = h.id
    WHERE ${where.join(' AND ')}
    ORDER BY l.linen_code
    LIMIT ? OFFSET ?
  `).all([...params, parseInt(page_size), offset]);

  res.json({ data: rows, total, page: parseInt(page), page_size: parseInt(page_size) });
});

// GET /api/linens/search — universal search by rfid or code
router.get('/search', authenticate, (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Search query required' });

  const linen = db.prepare(`
    SELECT l.*, lt.name as type_name, lt.category, lt.max_washes, lt.warning_pct, lt.billing_rate,
           h.name as hotel_name
    FROM linens l
    JOIN linen_types lt ON l.linen_type_id = lt.id
    JOIN hotels h ON l.hotel_id = h.id
    WHERE l.linen_code=? OR l.rfid_tag=?
  `).get(q.trim(), q.trim());

  if (!linen) return res.status(404).json({ error: 'Linen not found' });

  const history = db.prepare(`
    SELECT bi.*, b.batch_code, b.dispatched_at, b.status as batch_status,
           lp.name as laundry_name
    FROM batch_items bi
    JOIN batches b ON bi.batch_id = b.id
    JOIN laundry_providers lp ON b.laundry_provider_id = lp.id
    WHERE bi.linen_id=?
    ORDER BY b.dispatched_at DESC LIMIT 20
  `).all(linen.id);

  res.json({ linen, history });
});

// GET /api/linens/:id
router.get('/:id', authenticate, (req, res) => {
  const linen = db.prepare(`
    SELECT l.*, lt.name as type_name, lt.category, lt.max_washes, lt.warning_pct,
           h.name as hotel_name
    FROM linens l JOIN linen_types lt ON l.linen_type_id=lt.id JOIN hotels h ON l.hotel_id=h.id
    WHERE l.id=?
  `).get(req.params.id);
  if (!linen) return res.status(404).json({ error: 'Linen not found' });
  res.json(linen);
});

// GET /api/linens/:id/history
router.get('/:id/history', authenticate, (req, res) => {
  const history = db.prepare(`
    SELECT bi.*, b.batch_code, b.dispatched_at, b.returned_at, b.status as batch_status,
           lp.name as laundry_name
    FROM batch_items bi
    JOIN batches b ON bi.batch_id=b.id
    JOIN laundry_providers lp ON b.laundry_provider_id=lp.id
    WHERE bi.linen_id=?
    ORDER BY b.dispatched_at DESC
  `).all(req.params.id);
  res.json(history);
});

// POST /api/linens — enroll single
router.post('/', authenticate, (req, res) => {
  const { rfid_tag, linen_type_id, hotel_id, brand, gsm, purchase_date } = req.body;
  if (!rfid_tag || !linen_type_id || !hotel_id) {
    return res.status(400).json({ error: 'rfid_tag, linen_type_id, and hotel_id are required' });
  }

  const existing = db.prepare('SELECT id FROM linens WHERE rfid_tag=?').get(rfid_tag);
  if (existing) return res.status(409).json({ error: 'RFID tag already enrolled' });

  const typeExists = db.prepare('SELECT id FROM linen_types WHERE id=?').get(linen_type_id);
  if (!typeExists) return res.status(400).json({ error: 'Invalid linen type' });

  // Generate unique linen code
  const lastCode = db.prepare("SELECT linen_code FROM linens ORDER BY rowid DESC LIMIT 1").get();
  const lastNum = lastCode ? parseInt(lastCode.linen_code.replace('LN-', ''), 10) : 1000;
  const linen_code = `LN-${lastNum + 1}`;

  const id = db.generateId();
  const notes = [brand && `Brand: ${brand}`, gsm && `GSM: ${gsm}`, purchase_date && `Purchased: ${purchase_date}`].filter(Boolean).join(', ');

  db.prepare('INSERT INTO linens (id,linen_code,rfid_tag,linen_type_id,hotel_id,status,notes) VALUES (?,?,?,?,?,?,?)')
    .run(id, linen_code, rfid_tag.trim().toUpperCase(), linen_type_id, hotel_id, 'in_house', notes || null);

  db.prepare('INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(db.generateId(), req.user.id, 'enroll', 'linen', id, `Enrolled ${linen_code} with RFID ${rfid_tag}`);

  res.status(201).json(db.prepare('SELECT l.*,lt.name as type_name FROM linens l JOIN linen_types lt ON l.linen_type_id=lt.id WHERE l.id=?').get(id));
});

// POST /api/linens/bulk — bulk enroll
router.post('/bulk', authenticate, (req, res) => {
  const { items, hotel_id } = req.body; // items: [{rfid_tag, linen_type_id}]
  if (!Array.isArray(items) || !hotel_id) return res.status(400).json({ error: 'items array and hotel_id required' });

  const lastCode = db.prepare("SELECT linen_code FROM linens ORDER BY rowid DESC LIMIT 1").get();
  let lastNum = lastCode ? parseInt(lastCode.linen_code.replace('LN-', ''), 10) : 1000;

  const enrolled = [];
  const errors = [];

  const insert = db.prepare('INSERT INTO linens (id,linen_code,rfid_tag,linen_type_id,hotel_id,status) VALUES (?,?,?,?,?,?)');
  const txn = db.transaction(() => {
    for (const item of items) {
      const exists = db.prepare('SELECT id FROM linens WHERE rfid_tag=?').get(item.rfid_tag);
      if (exists) { errors.push({ rfid_tag: item.rfid_tag, error: 'Already enrolled' }); continue; }
      lastNum++;
      const code = `LN-${lastNum}`;
      const id = db.generateId();
      insert.run(id, code, item.rfid_tag.trim().toUpperCase(), item.linen_type_id, hotel_id, 'in_house');
      enrolled.push({ id, linen_code: code, rfid_tag: item.rfid_tag });
    }
  });
  txn();

  db.prepare('INSERT INTO audit_log (id,user_id,action,entity_type,details) VALUES (?,?,?,?,?)')
    .run(db.generateId(), req.user.id, 'bulk_enroll', 'linen', `Enrolled ${enrolled.length} linens`);

  res.status(201).json({ enrolled, errors, count: enrolled.length });
});

// PUT /api/linens/:id — update / retire
router.put('/:id', authenticate, (req, res) => {
  const { status, notes } = req.body;
  const linen = db.prepare('SELECT * FROM linens WHERE id=?').get(req.params.id);
  if (!linen) return res.status(404).json({ error: 'Linen not found' });

  const retired_at = status === 'retired' ? new Date().toISOString() : linen.retired_at;
  db.prepare('UPDATE linens SET status=COALESCE(?,status),notes=COALESCE(?,notes),retired_at=? WHERE id=?')
    .run(status, notes, retired_at, req.params.id);

  db.prepare('INSERT INTO audit_log (id,user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(db.generateId(), req.user.id, 'update_linen', 'linen', req.params.id, `Status changed to ${status || 'unchanged'}`);

  res.json(db.prepare('SELECT l.*,lt.name as type_name FROM linens l JOIN linen_types lt ON l.linen_type_id=lt.id WHERE l.id=?').get(req.params.id));
});

module.exports = router;
