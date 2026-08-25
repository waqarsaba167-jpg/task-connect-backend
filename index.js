const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'task_connect_secret_key';

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());

// Test Route
app.get('/', (req, res) => {
  res.json({ status: 'Task Connect Backend is running successfully!' });
});

// --- Database Tables Setup ---
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        profile_picture TEXT DEFAULT '',
        role VARCHAR(50) DEFAULT 'user',
        approved BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        link TEXT NOT NULL,
        reward NUMERIC DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        amount NUMERIC NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables verified/created successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

initDb();

// --- AUTH ROUTES (Signup & Login) ---
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username aur password dono lazmi hain.' });
    }

    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Yeh username pehle se mojood hai.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await pool.query(
      'INSERT INTO users (username, password, approved) VALUES ($1, $2, $3) RETURNING id, username, role, approved',
      [username, hashedPassword, false]
    );

    res.status(201).json({
      message: 'Account kamyaabi se ban gaya! Admin approval ka intezaar hai.',
      user: newUser.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username aur password likhna zaroori hai.' });
    }

    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Ghalat username ya password.' });
    }

    const user = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Ghalat username ya password.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login kamyaab ho gaya!',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        approved: user.approved,
        profile_picture: user.profile_picture
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// --- TASK ROUTES ---
app.get('/api/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY id DESC');
    res.json({ success: true, tasks: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching tasks' });
  }
});

// --- ADMIN PANEL ROUTES ---
// 1. Get all users (for member approval & management)
app.get('/api/admin/users', async (req, res) => {
  try {
    let withdrawalId = null; // Safely initialized variable
    const result = await pool.query('SELECT id, username, role, approved, profile_picture, created_at FROM users ORDER BY id DESC');
    res.json({ success: true, users: result.rows, sampleWithdrawalId: withdrawalId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching users' });
  }
});

// 2. Approve User / Member
app.put('/api/admin/approve-user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE users SET approved = true WHERE id = $1', [id]);
    res.json({ message: 'User successfully approved by admin.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error approving user' });
  }
});

// 3. Add New Task / Link
app.post('/api/admin/tasks', async (req, res) => {
  try {
    const { title, link, reward } = req.body;
    if (!title || !link) {
      return res.status(400).json({ error: 'Title aur link dono zaroori hain.' });
    }
    const newTask = await pool.query(
      'INSERT INTO tasks (title, link, reward) VALUES ($1, $2, $3) RETURNING *',
      [title, link, reward || 0]
    );
    res.status(201).json({ message: 'Task added successfully!', task: newTask.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error adding task' });
  }
});

// 4. Delete Task / Link
app.delete('/api/admin/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    res.json({ message: 'Task deleted successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting task' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
