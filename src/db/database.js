const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/linentrack.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let _sqlJsDb = null;
let _saveTimer = null;

function persist() {
  if (!_sqlJsDb) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const data = _sqlJsDb.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch(e) { console.error('[DB] persist error:', e.message); }
  }, 300);
}

process.on('exit', () => {
  if (_sqlJsDb) {
    try { fs.writeFileSync(DB_PATH, Buffer.from(_sqlJsDb.export())); } catch {}
  }
});
['SIGINT','SIGTERM'].forEach(s => process.on(s, () => process.exit(0)));

function toObj(stmt) {
  return stmt.getAsObject();
}

// Normalize params: handle (array), (a,b,c...) or no-args all as flat array
function normalize(...args) {
  if (args.length === 0) return [];
  if (args.length === 1) {
    const a = args[0];
    if (Array.isArray(a)) return a;
    if (a === undefined || a === null) return [];
    return [a];
  }
  return args; // spread args like .run(a, b, c)
}

function makeStmt(sql) {
  return {
    run(...args) {
      const p = normalize(...args);
      const stmt = _sqlJsDb.prepare(sql);
      try { stmt.run(p); } finally { stmt.free(); }
      persist();
      return { changes: _sqlJsDb.getRowsModified() };
    },
    get(...args) {
      const p = normalize(...args);
      const stmt = _sqlJsDb.prepare(sql);
      try {
        stmt.bind(p);
        if (stmt.step()) return toObj(stmt);
        return undefined;
      } finally { stmt.free(); }
    },
    all(...args) {
      const p = normalize(...args);
      const stmt = _sqlJsDb.prepare(sql);
      try {
        stmt.bind(p);
        const rows = [];
        while (stmt.step()) rows.push(toObj(stmt));
        return rows;
      } finally { stmt.free(); }
    }
  };
}

const db = {
  generateId: () => uuidv4(),

  exec(sql) {
    _sqlJsDb.run(sql);
    persist();
    return this;
  },

  prepare(sql) { return makeStmt(sql); },

  transaction(fn) {
    return (...args) => {
      _sqlJsDb.run('BEGIN');
      try {
        const result = fn(...args);
        _sqlJsDb.run('COMMIT');
        persist();
        return result;
      } catch(e) {
        try { _sqlJsDb.run('ROLLBACK'); } catch {}
        throw e;
      }
    };
  },

  pragma(s) { try { _sqlJsDb.run(`PRAGMA ${s}`); } catch {} }
};

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _sqlJsDb = new SQL.Database(buf);
    console.log(`[DB] Loaded: ${DB_PATH}`);
  } else {
    _sqlJsDb = new SQL.Database();
    console.log(`[DB] Created: ${DB_PATH}`);
  }

  _sqlJsDb.run('PRAGMA foreign_keys=ON');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const stmts = schema.replace(/--[^\n]*/g, '').split(';')
    .map(s => s.trim()).filter(s => s.length > 0);
  for (const s of stmts) { try { _sqlJsDb.run(s); } catch {} }

  return db;
}

module.exports = db;
module.exports.initDb = initDb;
