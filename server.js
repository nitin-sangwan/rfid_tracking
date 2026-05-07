require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./src/db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// --- Rate Limiting ---
const apiLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 500, 
    standardHeaders: true, 
    legacyHeaders: false 
});
const authLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 30 
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

// --- API Routes ---
app.use('/api/auth',    require('./src/routes/auth'));
app.use('/api',         require('./src/routes/master'));
app.use('/api/linens',  require('./src/routes/linens'));
app.use('/api/batches', require('./src/routes/batches'));
app.use('/api/boq',     require('./src/routes/boq'));
app.use('/api',         require('./src/routes/misc'));

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// --- Static Files & Frontend ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- Global Error Handler ---
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ 
      error: err.message || 'Internal server error' 
  });
});

// --- Database Initialization ---
// Vercel serverless functions mein hum manually listen nahi karte, 
// Vercel khud app instance ko handle karta hai.
initDb()
  .then(() => {
    console.log('Database ready.');
    
    // Sirf local development mein listen karein, Vercel par nahi.
    if (process.env.NODE_ENV !== 'production') {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n LinenTrack running → http://localhost:${PORT}\n`);
      });
    }
  })
  .catch(err => {
    console.error('DB init failed on startup:', err);
  });

// CRITICAL: Vercel ko batane ke liye ki yeh hamari Express app hai
module.exports = app;