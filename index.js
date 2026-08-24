const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Mukammal Database Tables Setup (Tasks, Users, Submissions)
async function initAllTables() {
  try {
    // 1. Tasks Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        reward INT DEFAULT 0,
        link TEXT,
        task_type VARCHAR(50) DEFAULT 'like'
      );
    `);

    // 2. Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        balance INT DEFAULT 0,
        profile_pic TEXT,
        is_approved BOOLEAN DEFAULT FALSE
      );
    `);

    // 3. Task Submissions Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        user_id INT,
        task_id INT,
        status VARCHAR(50) DEFAULT 'pending',
        proof TEXT
      );
    `);

    console.log("All database tables initialized successfully!");
  } catch (err) {
    console.error("Database initialization error:", err);
  }
}

initAllTables();

// --- API ROUTES ---

// 1. Home Check Route
app.get('/', (req, res) => {
  res.send('Task Connect Global Earning App Backend is Live & Ready!');
});

// 2. Admin: Naya Task Add karne ke liye API
app.post('/api/admin/tasks', async (req, res) => {
  try {
    const { title, reward, link, task_type } = req.body;
    const newTask = await pool.query(
      'INSERT INTO tasks (title, reward, link, task_type) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, reward, link, task_type || 'like']
    );
    res.status(201).json({ success: true, task: newTask.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while adding task' });
  }
});

// 3. Tamam Tasks Dekhne ke liye API
app.get('/api/tasks', async (req, res) => {
  try {
    const allTasks = await pool.query('SELECT * FROM tasks ORDER BY id DESC');
    res.json({ success: true, tasks: allTasks.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while fetching tasks' });
  }
});

// 4. Admin: Task Delete karne ke liye API
app.delete('/api/admin/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    res.json({ success: true, message: 'Task deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while deleting task' });
  }
});

// 5. User Register / Profile API
app.post('/api/users', async (req, res) => {
  try {
    const { username, profile_pic } = req.body;
    const user = await pool.query(
      'INSERT INTO users (username, profile_pic) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET profile_pic = $2 RETURNING *',
      [username, profile_pic]
    );
    res.status(201).json({ success: true, user: user.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error with user profile' });
  }
});

// 6. Admin: Pending Users List Dekhne ke liye
app.get('/api/admin/users/pending', async (req, res) => {
  try {
    const pendingUsers = await pool.query('SELECT * FROM users WHERE is_approved = FALSE');
    res.json({ success: true, users: pendingUsers.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 7. Admin: User Approve karne ke liye
app.post('/api/admin/users/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE users SET is_approved = TRUE WHERE id = $1', [id]);
    res.json({ success: true, message: 'User approved successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 8. Task Complete & Reward Claim API
app.post('/api/tasks/claim', async (req, res) => {
  try {
    const { user_id, task_id } = req.body;
    const taskResult = await pool.query('SELECT reward FROM tasks WHERE id = $1', [task_id]);
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }
    const reward = taskResult.rows[0].reward;

    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [reward, user_id]);
    await pool.query(
      'INSERT INTO submissions (user_id, task_id, status) VALUES ($1, $2, $3)',
      [user_id, task_id, 'completed']
    );

    res.json({ success: true, message: 'Reward added successfully!', earned: reward });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while claiming task' });
  }
});

// 9. Withdrawal Request API
app.post('/api/withdrawals', async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [user_id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const currentBalance = userResult.rows[0].balance;
    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, user_id]);
    res.json({ success: true, message: 'Withdrawal request submitted successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during withdrawal' });
  }
});

// Server Listen
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
