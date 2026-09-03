const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET || 'taskconnect_secret_key_2026';

// In-Memory Database Simulation (Production ready for Railway)
let users = [];
let tasks = [
  { id: "1", title: "Follow our YouTube Channel", category: "YouTube", reward: 100, link: "https://youtube.com" },
  { id: "2", title: "Watch TikTok Viral Video", category: "TikTok", reward: 80, link: "https://tiktok.com" }
];
let userTasksCompleted = {}; // track completed tasks per user
let withdrawals = [];
let chatMessages = [
  { id: "1", name: "System", text: "Welcome to Task Connect Community Chat! No links or numbers allowed.", isAdmin: true }
];
let adminWalletPoints = 0; // Admin 30% commission store

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access token required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// 1. REGISTER
app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, referralCode, deviceId } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields are required" });

    // Anti-Fraud: 1 Device = 1 Account Check
    if (deviceId) {
      const existingDevice = users.find(u => u.deviceId === deviceId);
      if (existingDevice) {
        return res.status(400).json({ error: "Fraud Alert: Only one account is allowed per mobile device!" });
      }
    }

    const existingUser = users.find(u => u.email === email);
    if (existingUser) return res.status(400).json({ error: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const role = users.length === 0 ? "admin" : "user"; // First registered user becomes Admin automatically

    const newUser = {
      id: Date.now().toString(),
      name,
      email,
      password: hashedPassword,
      points: 0,
      role,
      status: "active",
      deviceId: deviceId || "unknown"
    };

    users.push(newUser);
    const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET);
    res.json({ token, role: newUser.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. LOGIN
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user) return res.status(400).json({ error: "User not found" });

    if (user.status === "blocked") {
      return res.status(403).json({ error: "Your account has been blocked by Admin due to policy violation." });
    }

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ error: "Invalid password" });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
    res.json({ token, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. GET USER PROFILE
app.get('/user/me', authenticateToken, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    name: user.name,
    email: user.email,
    points: user.points,
    pkrEquivalent: (user.points * 0.5).toFixed(2), // 1 point = 0.5 PKR calculation
    role: user.role
  });
});

// 4. GET TASKS
app.get('/tasks', authenticateToken, (req, res) => {
  const userCompleted = userTasksCompleted[req.user.id] || [];
  const formattedTasks = tasks.map(t => ({
    ...t,
    completed: userCompleted.includes(t.id)
  }));
  res.json({ tasks: formattedTasks });
});

// 5. COMPLETE TASK (70% User / 30% Admin Split)
app.post('/tasks/:id/complete', authenticateToken, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  if (!userTasksCompleted[user.id]) userTasksCompleted[user.id] = [];
  if (userTasksCompleted[user.id].includes(task.id)) {
    return res.status(400).json({ error: "Task already completed!" });
  }

  userTasksCompleted[user.id].push(task.id);

  // Revenue 70/30 Split Calculation
  const userShare = Math.floor(task.reward * 0.70); // 70% to User
  const adminShare = Math.floor(task.reward * 0.30); // 30% to Admin Wallet

  user.points += userShare;
  adminWalletPoints += adminShare;

  res.json({ message: `Task verified! You earned ${userShare} points (70%). Admin commission collected.` });
});

// 6. WITHDRAWAL REQUEST
app.post('/wallet/withdraw', authenticateToken, (req, res) => {
  const { amountPoints, gateway, accountNumber } = req.body;
  const user = users.find(u => u.id === req.user.id);

  if (!amountPoints || amountPoints < 500) {
    return res.status(400).json({ error: "Minimum withdrawal limit is 500 points." });
  }
  if (user.points < amountPoints) {
    return res.status(400).json({ error: "Insufficient points in your wallet." });
  }

  user.points -= amountPoints;

  const wd = {
    id: Date.now().toString(),
    userId: user.id,
    name: user.name,
    amount_points: amountPoints,
    gateway,
    accountNumber,
    status: "pending"
  };
  withdrawals.push(wd);
  res.json({ message: "Withdrawal request submitted successfully! Awaiting Admin approval." });
});

// 7. COMMUNITY CHAT (Anti-Spam / Anti-Link / Anti-Phone Detection)
app.get('/chat/messages', authenticateToken, (req, res) => {
  res.json({ messages: chatMessages });
});

app.post('/chat/messages', authenticateToken, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Message cannot be empty" });

  // Anti-Spam Check: Detect Links or Phone Numbers
  const hasLink = /(https?:\/\/|www\.)/i.test(text);
  const hasPhone = /(\+?\d{10,}|03\d{9})/i.test(text);

  if (hasLink || hasPhone) {
    return res.status(400).json({ 
      error: "WARNING! Sending phone numbers or external links is strictly prohibited. If you try again, Admin will block your account permanently!" 
    });
  }

  const user = users.find(u => u.id === req.user.id);
  chatMessages.push({
    id: Date.now().toString(),
    name: user.name,
    text,
    isAdmin: user.role === "admin"
  });

  if (chatMessages.length > 50) chatMessages.shift(); // keep last 50 messages
  res.json({ success: true });
});

// 8. ADMIN APIS
app.get('/admin/stats', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  res.json({
    totalUsers: users.length,
    totalTasks: tasks.length,
    pendingWithdrawals: withdrawals.filter(w => w.status === "pending").length,
    adminWalletPoints
  });
});

app.get('/admin/users', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  res.json({ users: { users } });
});

app.post('/admin/users/:id/block', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  const u = users.find(user => user.id === req.params.id);
  if (u) u.status = "blocked";
  res.json({ success: true });
});

app.post('/admin/users/:id/unblock', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  const u = users.find(user => user.id === req.params.id);
  if (u) u.status = "active";
  res.json({ success: true });
});

app.delete('/admin/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  users = users.filter(u => u.id !== req.params.id);
  res.json({ success: true });
});

app.get('/admin/withdrawals', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  res.json({ withdrawals });
});

app.post('/admin/withdrawals/:id/decide', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  const wd = withdrawals.find(w => w.id === req.params.id);
  if (wd) wd.status = req.body.status; // approved or rejected
  res.json({ success: true });
});

app.post('/admin/tasks', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  const { title, category, reward, link } = req.body;
  if (!title || !reward) return res.status(400).json({ error: "Title and reward required" });

  const newTask = {
    id: Date.now().toString(),
    title,
    category: category || "General",
    reward: parseInt(reward),
    link: link || "#"
  };
  tasks.push(newTask);
  res.json({ success: true, task: newTask });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Task Connect server running on port ${PORT}`));
