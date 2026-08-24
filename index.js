const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection using Railway's DATABASE_URL environment variable
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test Database Connection
pool.connect()
    .then(() => console.log('Connected to Neon PostgreSQL Database successfully!'))
    .catch(err => console.error('Database connection error:', err.stack));

// 1. Home Route
app.get('/', (req, res) => {
    res.send('Task Connect Backend is running successfully!');
});

// 2. Get All Tasks (App ke liye)
app.get('/api/tasks', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while fetching tasks' });
    }
});

// 3. Add a New Task (Admin Panel ke liye)
app.post('/api/tasks', async (req, res) => {
    const { title, description, link, reward } = req.body;
    try {
        const newDTask = await pool.query(
            'INSERT INTO tasks (title, description, link, reward) VALUES ($1, $2, $3, $4) RETURNING *',
            [title, description, link, reward]
        );
        res.json({ message: 'Task added successfully', task: newDTask.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while adding task' });
    }
});

// 4. Register or Get User
app.post('/api/users', async (req, res) => {
    const { telegram_id, username, profile_pic } = req.body;
    try {
        let user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
        
        if (user.rows.length > 0) {
            return res.json({ message: 'User already exists', user: user.rows[0] });
        }

        const newUser = await pool.query(
            'INSERT INTO users (telegram_id, username, profile_pic) VALUES ($1, $2, $3) RETURNING *',
            [telegram_id, username, profile_pic]
        );
        res.json({ message: 'User registered successfully', user: newUser.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error during user registration' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
