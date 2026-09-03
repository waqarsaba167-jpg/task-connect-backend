korequire("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

// =============================================================================
// CONFIG
// =============================================================================
const PORT = parseInt(process.env.PORT || "8080", 10);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL — add a Postgres database to this Railway project before starting the server.");
  process.exit(1);
}

// =============================================================================
// DATABASE (Postgres)
// =============================================================================
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

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      network TEXT,
      external_txn_id TEXT,
      points INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      meta TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(network, external_txn_id)
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

    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(active);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS link_strikes INTEGER NOT NULL DEFAULT 0;
  `);
}

// =============================================================================
// SETTINGS HELPERS
// =============================================================================
const SETTINGS_DEFAULTS = {
  pkrPerPoint: 2.0,
  minWithdrawalPoints: 100,
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

// =============================================================================
// MIDDLEWARE
// =============================================================================
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

function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// =============================================================================
// APP
// =============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many attempts — try again later." } });

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Auth ----------
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
  await dbRun(
    `INSERT INTO users (id, name, email, password_hash, points, referral_code, referred_by, status) VALUES (?, ?, ?, ?, 0, ?, ?, 'pending')`,
    [id, name, email.toLowerCase(), passwordHash, generateReferralCode(), referredBy]
  );

  const user = await dbGet("SELECT * FROM users WHERE id = ?", [id]);
  res.status(201).json({ user: publicUser(user), pendingApproval: true });
}));

app.post("/auth/login", authLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const user = await dbGet("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  if (user.status === "banned") return res.status(403).json({ error: "This account has been suspended" });
  if (user.status === "pending") return res.status(403).json({ error: "Your account is awaiting admin approval" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });

  res.json({ token: signToken(user.id), user: publicUser(user) });
}));

// ---------- User ----------
app.get("/user/me", requireAuth, ah(async (req, res) => {
  const user = await dbGet("SELECT * FROM users WHERE id = ?", [req.userId]);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    id: user.id, name: user.name, email: user.email, points: user.points,
    pkrEquivalent: await pointsToPkr(user.points), referralCode: user.referral_code,
    status: user.status, role: user.role, photo: user.photo, createdAt: user.created_at,
  });
}));

// ---------- Tasks ----------
app.get("/tasks", requireAuth, ah(async (req, res) => {
  const rows = await dbAll(
    `SELECT t.*, (tc.user_id IS NOT NULL) as completed FROM tasks t
     LEFT JOIN task_completions tc ON tc.task_id = t.id AND tc.user_id = ?
     WHERE t.active = 1 ORDER BY t.created_at DESC`,
    [req.userId]
  );
  res.json({ tasks: rows.map((r) => ({ ...r, completed: !!r.completed })) });
}));

// ---------- Start Server ----------
initSchema().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Task Connect Backend running on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize database schema:", err);
});// Har 2 minute (120,000 milliseconds) ke baad ad trigger karne ka function
function startAdTimer() {
    const TWO_MINUTES = 2 * 60 * 1000; // 2 minutes in milliseconds

    setInterval(() => {
        // Yahan aap apna AdMob ad show karne wala function call karengi
        showRewardedOrBannerAd();
    }, TWO_MINUTES);
}

function showRewardedOrBannerAd() {
    console.log("2 minute ho gaye hain, ab ad show ki ja rahi hai.");
    // AdMob ad trigger logic yahan aayegi
}

// Jab app load ho toh timer start kar dein
window.onload = function() {
    startAdTimer();
};const path = require('path');

// Yeh line server ko batati hai ke style.css aur baqi files kahan hain
app.use(express.static(__dirname));

// Yeh line root URL ("/") par naya index.html page dikhaye gi
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
