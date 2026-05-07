FROM node:20-alpine

# System dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create data directory
RUN mkdir -p data && chmod 777 data

# Seed the database on first run
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/linentrack.db

EXPOSE 3000

# Entrypoint: seed if DB doesn't exist, then start
CMD ["/bin/sh", "-c", "[ ! -f /app/data/linentrack.db ] && node src/db/seed.js; node server.js"]
