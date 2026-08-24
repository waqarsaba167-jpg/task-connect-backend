const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Database connection using Railway environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test DB Connection Route
app.get('/', (req, res) => {
  res.send('Task Connect Backend is running successfully!');
});

// 1. Get all tasks
app.get('/api/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// 2. Add a new task (Admin feature)
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, reward, link } = req.body;
    const newCity = await pool.query(
      'INSERT INTO tasks (title, description, reward, link) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, description, reward, link]
    );
    res.json(newCity.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// 3. Delete a task (Admin feature)
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    res.json({ message: 'Task deleted successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// 4. Register or login user
app.post('/api/users', async (req, res) => {
  try {
    const { telegram_id, username, profile_pic } = req.body;
    
    // Check if user already exists
    const userCheck = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
    
    if (userCheck.rows.length > 0) {
      return res.json(userCheck.rows[0]);
    }

    // If not, create new user
    const newUser = await pool.query(
      'INSERT INTO users (telegram_id, username, profile_pic, balance) VALUES ($1, $2, $3, 0) RETURNING *',
      [telegram_id, username, profile_pic]
    );
    res.json(newUser.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
