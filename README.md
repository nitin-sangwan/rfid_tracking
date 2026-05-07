# LinenTrack — RFID Linen Management System
### Production-Ready · Node.js · SQLite · JWT Auth · Docker

---

## Stack
| Layer | Technology |
|---|---|
| Backend | Node.js 20 + Express 4 |
| Database | SQLite (better-sqlite3, WAL mode) |
| Auth | JWT (12hr expiry, bcrypt passwords) |
| Frontend | Vanilla JS SPA served by Express |
| Container | Docker + docker-compose |
| Security | Helmet, CORS, Rate Limiting |

---

## Quick Start (Docker — Recommended)

```bash
# 1. Clone / unzip project
cd linentrack

# 2. Copy env file
cp .env.example .env
# Edit .env — at minimum change JWT_SECRET

# 3. Run
docker-compose up -d

# 4. Open browser
open http://localhost:3000
```

## Quick Start (Node.js directly)

```bash
npm install
cp .env.example .env

# Seed sample data
node src/db/seed.js

# Start server
npm start           # production
npm run dev         # development (nodemon)
```

---

## Demo Credentials

| Role | Email | Password |
|---|---|---|
| Platform Admin | admin@linentrack.com | Admin@123 |
| Hotel Admin | hadmin@grandplaza.com | Admin@123 |
| Hotel Manager | manager@grandplaza.com | Staff@123 |
| Staff | staff@grandplaza.com | Staff@123 |

---

## API Reference

### Auth
```
POST /api/auth/login         { email, password }
GET  /api/auth/me            Bearer token
POST /api/auth/change-password
```

### Linens
```
GET  /api/linens             ?hotel_id=&status=&linen_type_id=&search=&page=&page_size=
GET  /api/linens/search      ?q=<rfid_or_code>
GET  /api/linens/:id
GET  /api/linens/:id/history
POST /api/linens             { rfid_tag, linen_type_id, hotel_id, brand?, gsm?, purchase_date? }
POST /api/linens/bulk        { items:[{rfid_tag,linen_type_id}], hotel_id }
PUT  /api/linens/:id         { status?, notes? }
```

### Batches
```
GET  /api/batches            ?hotel_id=&status=&page=&page_size=
GET  /api/batches/:id
POST /api/batches            { hotel_id, laundry_provider_id, linen_ids[], sla_hours?, notes? }
POST /api/batches/:id/acknowledge
POST /api/batches/:id/return { returned_items:[{linen_id, return_status}] }
POST /api/batches/check-overdue
```

### BOQ Billing
```
GET  /api/boq                ?hotel_id=&year=&status=
GET  /api/boq/:id
POST /api/boq/generate       { hotel_id, month, year }
PUT  /api/boq/:id            { status }
PUT  /api/boq/:id/items/:itemId  { billable_count, rate }
```

### Master Data
```
GET/POST/PUT  /api/hotels
GET/POST/PUT  /api/laundry-providers
GET/POST/PUT  /api/linen-types
```

### Reports
```
GET /api/reports/dashboard   ?hotel_id=
GET /api/reports/stock       ?hotel_id=
GET /api/reports/turnaround  ?hotel_id=
```

### Misc
```
GET  /api/alerts             ?hotel_id=&resolved=0|1
POST /api/alerts/:id/resolve
GET  /api/users
POST /api/users
PUT  /api/users/:id
GET  /api/support            ?hotel_id=&status=
POST /api/support
PUT  /api/support/:id
```

---

## Production Checklist

- [ ] Set strong `JWT_SECRET` in `.env` (min 32 random chars)
- [ ] Set `NODE_ENV=production`
- [ ] Mount persistent volume for `/app/data` (Docker)
- [ ] Put behind nginx reverse proxy with SSL
- [ ] Set `CORS_ORIGIN` to your domain
- [ ] Configure regular SQLite backups (copy `data/linentrack.db`)

## Nginx Reverse Proxy (example)

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Backup

```bash
# Backup database
cp data/linentrack.db backups/linentrack-$(date +%Y%m%d).db

# Docker volume backup
docker run --rm -v linentrack_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/linentrack-backup.tar.gz /data
```

---

## Project Structure

```
linentrack/
├── server.js              # Express entry point
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── public/
│   └── index.html         # Full SPA frontend
├── src/
│   ├── db/
│   │   ├── schema.sql     # Database schema
│   │   ├── database.js    # SQLite connection
│   │   └── seed.js        # Sample data
│   ├── middleware/
│   │   └── auth.js        # JWT + role middleware
│   └── routes/
│       ├── auth.js        # Login, profile
│       ├── linens.js      # Enrollment, inventory
│       ├── batches.js     # Dispatch, returns
│       ├── boq.js         # Billing
│       ├── master.js      # Hotels, providers, types
│       └── misc.js        # Reports, alerts, users, support
```
