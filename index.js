const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL connection pool setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Database tables initialization
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        points INT DEFAULT 0
      );
    `);
    console.log("Database tables checked/created successfully.");
  } catch (err) {
    console.error("Error initializing database:", err);
  }
}

initDb();

// Simple test route
app.get('/', (req, res) => {
  res.send('Task Connect Backend with PostgreSQL is running live!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
