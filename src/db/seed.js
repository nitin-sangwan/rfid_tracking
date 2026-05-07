const path = require('path');
const { initDb } = require('./database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

async function seed() {
  const db = await initDb();
  console.log('[SEED] Seeding database...');

  // Clear all tables
  const tables = ['audit_log','support_tickets','alerts','boq_items','boq','batch_items','batches','linens','users','linen_types','laundry_providers','hotels'];
  for (const t of tables) { try { db.exec(`DELETE FROM ${t}`); } catch {} }

  // Hotels
  const hotels = [
    { id: uuidv4(), name: 'Grand Plaza Hotel', city: 'Delhi', rooms: 180 },
    { id: uuidv4(), name: 'The Riverside Inn', city: 'Agra', rooms: 80 },
    { id: uuidv4(), name: 'City Suites Delhi', city: 'Delhi', rooms: 60 }
  ];
  for (const h of hotels) db.prepare('INSERT INTO hotels (id,name,city,rooms) VALUES (?,?,?,?)').run([h.id,h.name,h.city,h.rooms]);

  // Laundry providers
  const providers = [
    { id: uuidv4(), name: 'Sunrise Laundry', contact: '+91-9810000001', sla_hours: 24 },
    { id: uuidv4(), name: 'CleanFresh Services', contact: '+91-9820000002', sla_hours: 22 },
    { id: uuidv4(), name: 'QuickWash Co.', contact: '+91-9830000003', sla_hours: 18 }
  ];
  for (const p of providers) db.prepare('INSERT INTO laundry_providers (id,name,contact,sla_hours) VALUES (?,?,?,?)').run([p.id,p.name,p.contact,p.sla_hours]);

  // Linen types
  const types = [
    { id: uuidv4(), name: 'Bed Sheet (King)', category: 'Bedding', max_washes: 120, warning_pct: 90, action_at_limit: 'flag', billing_rate: 12 },
    { id: uuidv4(), name: 'Bed Sheet (Queen)', category: 'Bedding', max_washes: 120, warning_pct: 90, action_at_limit: 'flag', billing_rate: 10 },
    { id: uuidv4(), name: 'Pillow Cover', category: 'Bedding', max_washes: 100, warning_pct: 90, action_at_limit: 'flag', billing_rate: 6 },
    { id: uuidv4(), name: 'Bath Towel', category: 'Bathroom', max_washes: 80, warning_pct: 90, action_at_limit: 'retire', billing_rate: 8 },
    { id: uuidv4(), name: 'Hand Towel', category: 'Bathroom', max_washes: 80, warning_pct: 90, action_at_limit: 'retire', billing_rate: 5 },
    { id: uuidv4(), name: 'Bath Mat', category: 'Bathroom', max_washes: 60, warning_pct: 90, action_at_limit: 'retire', billing_rate: 15 }
  ];
  for (const t of types) db.prepare('INSERT INTO linen_types (id,name,category,max_washes,warning_pct,action_at_limit,billing_rate) VALUES (?,?,?,?,?,?,?)').run([t.id,t.name,t.category,t.max_washes,t.warning_pct,t.action_at_limit,t.billing_rate]);

  // Users
  const adminHash = bcrypt.hashSync('Admin@123', 10);
  const staffHash = bcrypt.hashSync('Staff@123', 10);
  const users = [
    { id: uuidv4(), name: 'Rajiv Sharma', email: 'admin@linentrack.com', hash: adminHash, role: 'platform_admin', hotel_id: null },
    { id: uuidv4(), name: 'Priya Mehta', email: 'hadmin@grandplaza.com', hash: adminHash, role: 'hotel_admin', hotel_id: hotels[0].id },
    { id: uuidv4(), name: 'Ankit Verma', email: 'manager@grandplaza.com', hash: staffHash, role: 'hotel_manager', hotel_id: hotels[0].id },
    { id: uuidv4(), name: 'Sunita Rao', email: 'manager@riverside.com', hash: staffHash, role: 'hotel_manager', hotel_id: hotels[1].id },
    { id: uuidv4(), name: 'Kabir Khan', email: 'staff@grandplaza.com', hash: staffHash, role: 'staff', hotel_id: hotels[0].id }
  ];
  for (const u of users) db.prepare('INSERT INTO users (id,name,email,password_hash,role,hotel_id) VALUES (?,?,?,?,?,?)').run([u.id,u.name,u.email,u.hash,u.role,u.hotel_id]);

  // Linens (approx 400)
  let linenNum = 1000;
  const statuses = ['in_house','in_house','in_house','at_laundry','at_laundry'];
  const allLinens = [];
  for (const hotel of hotels) {
    const dist = [
      [types[0], Math.floor(hotel.rooms*1.2)], [types[1], Math.floor(hotel.rooms*1.0)],
      [types[2], Math.floor(hotel.rooms*1.8)], [types[3], Math.floor(hotel.rooms*1.5)],
      [types[4], Math.floor(hotel.rooms*1.2)], [types[5], Math.floor(hotel.rooms*0.25)]
    ];
    for (const [t, count] of dist) {
      for (let i = 0; i < count; i++) {
        linenNum++;
        const id = uuidv4();
        const code = `LN-${linenNum}`;
        const hex = () => Math.floor(Math.random()*256).toString(16).padStart(2,'0').toUpperCase();
        const rfid = `RF:${hex()}:${hex()}:${hex()}:${hex()}`;
        const washes = Math.floor(Math.random() * t.max_washes * 0.85);
        const status = statuses[Math.floor(Math.random()*statuses.length)];
        const enrolled = new Date(Date.now() - Math.random()*365*86400000).toISOString();
        db.prepare('INSERT INTO linens (id,linen_code,rfid_tag,linen_type_id,hotel_id,status,wash_count,enrolled_at) VALUES (?,?,?,?,?,?,?,?)').run([id,code,rfid,t.id,hotel.id,status,washes,enrolled]);
        allLinens.push({ id, hotel_id: hotel.id, status });
      }
    }
  }

  // Batches for hotel[0]
  const hotelLinens = allLinens.filter(l => l.hotel_id === hotels[0].id && l.status === 'in_house');
  const batchDefs = [
    { daysAgo: 1, count: 80, status: 'at_laundry', provider: providers[0] },
    { daysAgo: 2, count: 60, status: 'returned', provider: providers[1] },
    { daysAgo: 3, count: 50, status: 'overdue', provider: providers[2] },
    { daysAgo: 4, count: 70, status: 'returned', provider: providers[0] }
  ];
  let batchNum = 1000;
  for (const def of batchDefs) {
    batchNum++;
    const batchId = uuidv4();
    const code = `BCH-2025-${String(batchNum).padStart(4,'0')}`;
    const dispatched = new Date(Date.now() - def.daysAgo*86400000).toISOString();
    const expected = new Date(new Date(dispatched).getTime() + def.provider.sla_hours*3600000).toISOString();
    const returned = def.status === 'returned' ? new Date(new Date(expected).getTime() + 3600000).toISOString() : null;
    const qrAck = new Date(new Date(dispatched).getTime() + 1800000).toISOString();
    db.prepare('INSERT INTO batches (id,batch_code,hotel_id,laundry_provider_id,dispatched_at,expected_return_at,returned_at,qr_acknowledged_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run([batchId,code,hotels[0].id,def.provider.id,dispatched,expected,returned,qrAck,def.status,users[2].id]);
    const items = hotelLinens.slice(0, def.count);
    for (const l of items) {
      const retAt = returned ? new Date(new Date(returned).getTime() - Math.random()*3600000).toISOString() : null;
      db.prepare('INSERT INTO batch_items (id,batch_id,linen_id,wash_count_before,returned_at,return_status) VALUES (?,?,?,?,?,?)').run([uuidv4(),batchId,l.id,5,retAt,retAt?'good':null]);
    }
  }

  // Alerts
  db.prepare('INSERT INTO alerts (id,type,severity,hotel_id,message,resolved) VALUES (?,?,?,?,?,0)').run([uuidv4(),'missing','critical',hotels[0].id,'12 Bed Sheets missing from BCH-2025-1001, not scanned for 9 days']);
  db.prepare('INSERT INTO alerts (id,type,severity,hotel_id,message,resolved) VALUES (?,?,?,?,?,0)').run([uuidv4(),'overdue','warning',hotels[0].id,'Batch BCH-2025-1003 overdue — QuickWash Co. 36hrs past ETA']);
  db.prepare('INSERT INTO alerts (id,type,severity,hotel_id,message,resolved) VALUES (?,?,?,?,?,0)').run([uuidv4(),'lifecycle','warning',hotels[0].id,'18 linens have exceeded 90% of their wash cycle limit']);
  db.prepare('INSERT INTO alerts (id,type,severity,hotel_id,message,resolved) VALUES (?,?,?,?,?,0)').run([uuidv4(),'boq_ready','info',hotels[0].id,'BOQ for January 2025 is ready for review']);

  // BOQ
  const boqId = uuidv4();
  db.prepare('INSERT INTO boq (id,hotel_id,month,year,status,total_amount) VALUES (?,?,?,?,?,?)').run([boqId,hotels[0].id,1,2025,'under_review',75392]);
  const boqRows = [[types[0].id,1640,42,1598,12,19176],[types[1].id,1220,18,1202,10,12020],[types[2].id,2480,55,2425,6,14550],[types[3].id,2100,38,2062,8,16496],[types[4].id,1760,24,1736,5,8680],[types[5].id,304,6,298,15,4470]];
  for (const [tid,wc,rwc,bc,rate,amt] of boqRows) db.prepare('INSERT INTO boq_items (id,boq_id,linen_type_id,wash_count,rewash_count,billable_count,rate,amount) VALUES (?,?,?,?,?,?,?,?)').run([uuidv4(),boqId,tid,wc,rwc,bc,rate,amt]);

  // Support tickets
  db.prepare('INSERT INTO support_tickets (id,ticket_code,hotel_id,created_by,issue_type,priority,description,status) VALUES (?,?,?,?,?,?,?,?)').run([uuidv4(),'TKT-2025-0041',hotels[0].id,users[1].id,'Missing Linen','critical','12 bed sheets unaccounted for since Jan 6.','in_progress']);
  db.prepare('INSERT INTO support_tickets (id,ticket_code,hotel_id,created_by,issue_type,priority,description,status) VALUES (?,?,?,?,?,?,?,?)').run([uuidv4(),'TKT-2025-0039',hotels[0].id,users[2].id,'Billing Issue','high','Dec BOQ shows 40 extra bath towel washes that were rewashes.','open']);

  // Final save
  const { DB_PATH: p } = process.env;
  const dbPath = p || path.join(__dirname, '../../data/linentrack.db');
  const fs = require('fs');
  const SqlJs = require('sql.js');
  // Force immediate save by calling _sqlJsDb.export() via the db internals
  // The persist() in database.js will handle this on exit
  console.log('[SEED] Done. Credentials:');
  console.log('  Platform Admin : admin@linentrack.com / Admin@123');
  console.log('  Hotel Admin    : hadmin@grandplaza.com / Admin@123');
  console.log('  Hotel Manager  : manager@grandplaza.com / Staff@123');
  console.log('  Staff          : staff@grandplaza.com / Staff@123');
  setTimeout(() => process.exit(0), 600); // Let persist() fire
}

seed().catch(e => { console.error(e); process.exit(1); });
