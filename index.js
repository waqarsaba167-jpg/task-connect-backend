require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL — add a Postgres database to this Railway project.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
});

function toPgQuery(text) {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

async function dbGet(text, params = []) {
  const result = await pool.query(toPgQuery(text), params);
  return result.rows[0];
}
async function dbAll(text, params = []) {
  const result = await pool.query(toPgQuery(text), params);
  return result.rows;
}
async function dbRun(text, params = []) {
  const result = await pool.query(toPgQuery(text), params);
  return { changes: result.rowCount, rows: result.rows };
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'user',
      photo TEXT,
      link_strikes INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      amount_points INTEGER NOT NULL,
      amount_pkr INTEGER NOT NULL,
      gateway TEXT NOT NULL,
      account_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      reward INTEGER NOT NULL,
      link TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS task_completions (
      user_id TEXT NOT NULL REFERENCES users(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS link_strikes INTEGER NOT NULL DEFAULT 0;
  `);
}

const SETTINGS_DEFAULTS = {
  pkrPerPoint: 2.0,
  minWithdrawalPoints: 100,
  commissionUserShare: 0.70,
};

async function getAllSettings() {
  const rows = await dbAll("SELECT key, value FROM settings");
  const overrides = {};
  for (const row of rows) {
    try { overrides[row.key] = JSON.parse(row.value); } catch (e) { overrides[row.key] = row.value; }
  }
  return { ...SETTINGS_DEFAULTS, ...overrides };
}
async function getSetting(key) { return (await getAllSettings())[key]; }
async function pointsToPkr(points) { return Math.round(points * (await getSetting("pkrPerPoint"))); }

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    const user = await dbGet("SELECT role FROM users WHERE id = ?", [req.userId]);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });
}

function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

app.get("/health", (req, res) => res.json({ ok: true }));

function generateReferralCode() { return "TCG-" + crypto.randomBytes(4).toString("hex").toUpperCase(); }
function signToken(userId) { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" }); }
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, points: u.points, referralCode: u.referral_code, status: u.status, role: u.role, photo: u.photo, createdAt: u.created_at };
}

app.post("/auth/register", authLimiter, ah(async (req, res) => {
  const { name, email, password, referralCode } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "name, email, and password are required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const existing = await dbGet("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
  if (existing) return res.status(409).json({ error: "An account with that email already exists" });

  let referredBy = null;
  if (referralCode) {
    const referrer = await dbGet("SELECT id FROM users WHERE referral_code = ?", [referralCode]);
    if (referrer) referredBy = referrer.id;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const id = crypto.randomUUID();
  
  // Make first registered user admin automatically for testing convenience
  const userCount = (await dbGet("SELECT COUNT(*) as count FROM users")).count;
  const role = parseInt(userCount, 10) === 0 ? "admin" : "user";

  await dbRun(
    `INSERT INTO users (id, name, email, password_hash, points, referral_code, referred_by, status, role) VALUES (?, ?, ?, ?, 0, ?, ?, 'active', ?)`,
    [id, name, email.toLowerCase(), passwordHash, generateReferralCode(), referredBy, role]
  );

  const user = await dbGet("SELECT * FROM users WHERE id = ?", [id]);
  res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
}));

app.post("/auth/login", authLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const user = await dbGet("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  if (user.status === "banned") return res.status(403).json({ error: "This account has been suspended" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });

  res.json({ token: signToken(user.id), user: publicUser(user) });
}));

app.get("/user/me", requireAuth, ah(async (req, res) => {
  const user = await dbGet("SELECT * FROM users WHERE id = ?", [req.userId]);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    id: user.id, name: user.name, email: user.email, points: user.points,
    pkrEquivalent: await pointsToPkr(user.points), referralCode: user.referral_code,
    status: user.status, role: user.role, photo: user.photo, createdAt: user.created_at,
  });
}));

app.get("/tasks", requireAuth, ah(async (req, res) => {
  const rows = await dbAll(
    `SELECT t.*, (tc.user_id IS NOT NULL) as completed FROM tasks t
     LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.user_id = ?
     WHERE t.active = 1 ORDER BY t.created_at DESC`,
    [req.userId]
  );
  res.json({ tasks: rows.map((r) => ({ ...r, completed: !!r.completed })) });
}));

app.post("/tasks/:id/complete", requireAuth, ah(async (req, res) => {
  const taskId = req.params.id;
  const task = await dbGet("SELECT * FROM tasks WHERE id = ? AND active = 1", [taskId]);
  if (!task) return res.status(404).json({ error: "Task not found" });

  const existing = await dbGet("SELECT * FROM task_completions WHERE user_id = ? AND task_id = ?", [req.userId, taskId]);
  if (existing) return res.status(400).json({ error: "Task already completed" });

  await dbRun("INSERT INTO task_completions (user_id, task_id) VALUES (?, ?)", [req.userId, taskId]);
  
  const settings = await getAllSettings();
  const userReward = Math.round(task.reward * (settings.commissionUserShare || 0.70));

  await dbRun("UPDATE users SET points = points + ? WHERE id = ?", [userReward, req.userId]);
  const user = await dbGet("SELECT points FROM users WHERE id = ?", [req.userId]);
  res.json({ success: true, points: user.points, earned: userReward });
}));

app.post("/wallet/withdraw", requireAuth, ah(async (req, res) => {
  const { amountPoints, gateway, accountNumber } = req.body;
  if (!amountPoints || !gateway || !accountNumber) {
    return res.status(400).json({ error: "All withdrawal fields are required" });
  }

  const minPoints = await getSetting("minWithdrawalPoints");
  if (amountPoints < minPoints) {
    return res.status(400).json({ error: `Minimum withdrawal is ${minPoints} points` });
  }

  const user = await dbGet("SELECT points FROM users WHERE id = ?", [req.userId]);
  if (user.points < amountPoints) {
    return res.status(400).json({ error: "Insufficient points" });
  }

  const pkrVal = await pointsToPkr(amountPoints);
  const id = crypto.randomUUID();

  await dbRun("UPDATE users SET points = points - ? WHERE id = ?", [amountPoints, req.userId]);
  await dbRun(
    `INSERT INTO withdrawals (id, user_id, amount_points, amount_pkr, gateway, account_number, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [id, req.userId, amountPoints, pkrVal, gateway, accountNumber]
  );

  res.json({ success: true, message: "Withdrawal request submitted successfully for admin approval." });
}));

app.get("/chat/messages", requireAuth, ah(async (req, res) => {
  const messages = await dbAll(
    `SELECT m.id, m.text, m.created_at, u.id as user_id, u.name, u.photo 
     FROM messages m JOIN users u ON m.user_id = u.id 
     ORDER BY m.created_at DESC LIMIT 50`
  );
  res.json({ messages: messages.reverse() });
}));

app.post("/chat/messages", requireAuth, ah(async (req, res) => {
  let { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "Message cannot be empty" });

  const phoneRegex = /(\+92|0)?3[0-9]{2}[0-9]{7}|\d{10,}/;
  const urlRegex = /(https?:\/\/[^\s]+|[a-zA-Z0-9-]+\.[a-zA-Z]{2,})/gi;

  if (phoneRegex.test(text) || urlRegex.test(text)) {
    await dbRun("UPDATE users SET link_strikes = link_strikes + 1 WHERE id = ?", [req.userId]);
    const user = await dbGet("SELECT link_strikes FROM users WHERE id = ?", [req.userId]);
    if (user.link_strikes >= 3) {
      await dbRun("UPDATE users SET status = 'banned' WHERE id = ?", [req.userId]);
      return res.status(403).json({ error: "Account banned due to sharing links/phone numbers." });
    }
    return res.status(400).json({ error: "Warning: Sharing phone numbers or links is prohibited." });
  }

  const id = crypto.randomUUID();
  await dbRun("INSERT INTO messages (id, user_id, text) VALUES (?, ?, ?)", [id, req.userId, text.trim()]);
  res.json({ success: true });
}));

// Admin Endpoints
app.get("/admin/stats", requireAdmin, ah(async (req, res) => {
  const totalUsers = (await dbGet("SELECT COUNT(*) as count FROM users")).count;
  const totalTasks = (await dbGet("SELECT COUNT(*) as count FROM tasks")).count;
  const pendingWithdrawals = (await dbGet("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'")).count;
  res.json({ totalUsers: parseInt(totalUsers, 10), totalTasks: parseInt(totalTasks, 10), pendingWithdrawals: parseInt(pendingWithdrawals, 10) });
}));

app.get("/admin/users", requireAdmin, ah(async (req, res) => {
  const users = await dbAll("SELECT id, name, email, points, status, role, photo, link_strikes, created_at FROM users ORDER BY created_at DESC");
  res.json({ users });
}));

app.post("/admin/users/:id/status", requireAdmin, ah(async (req, res) => {
  const { status } = req.body;
  await dbRun("UPDATE users SET status = ? WHERE id = ?", [status, req.params.id]);
  res.json({ success: true });
}));

app.post("/admin/users/:id/role", requireAdmin, ah(async (req, res) => {
  const { role } = req.body;
  await dbRun("UPDATE users SET role = ? WHERE id = ?", [role, req.params.id]);
  res.json({ success: true });
}));

app.delete("/admin/users/:id", requireAdmin, ah(async (req, res) => {
  await dbRun("DELETE FROM users WHERE id = ?", [req.params.id]);
  res.json({ success: true });
}));

app.get("/admin/withdrawals", requireAdmin, ah(async (req, res) => {
  const withdrawals = await dbAll(`SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC`);
  res.json({ withdrawals });
}));

app.post("/admin/withdrawals/:id/decide", requireAdmin, ah(async (req, res) => {
  const { status } = req.body;
  const w = await dbGet("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'", [req.params.id]);
  if (!w) return res.status(404).json({ error: "Pending withdrawal not found" });
  if (status === "rejected") {
    await dbRun("UPDATE users SET points = points + ? WHERE id = ?", [w.amount_points, w.user_id]);
  }
  await dbRun("UPDATE withdrawals SET status = ?, decided_at = NOW() WHERE id = ?", [status, req.params.id]);
  res.json({ success: true });
}));

app.get("/admin/tasks", requireAdmin, ah(async (req, res) => {
  const tasks = await dbAll("SELECT * FROM tasks ORDER BY created_at DESC");
  res.json({ tasks });
}));

app.post("/admin/tasks", requireAdmin, ah(async (req, res) => {
  const { title, category, reward, link, active } = req.body;
  const id = crypto.randomUUID();
  await dbRun("INSERT INTO tasks (id, title, category, reward, link, active) VALUES (?, ?, ?, ?, ?, ?)", [
    id, title, category, reward, link, active !== undefined ? active : 1
  ]);
  res.json({ success: true, id });
}));

app.delete("/admin/tasks/:id", requireAdmin, ah(async (req, res) => {
  await dbRun("DELETE FROM tasks WHERE id = ?", [req.params.id]);
  res.json({ success: true });
}));

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initSchema().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Task Connect running on port ${PORT}`);
  });
}).catch(err => {
  console.error("Schema init error:", err);
});
