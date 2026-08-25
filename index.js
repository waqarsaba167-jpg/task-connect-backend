require("dotenv").config();
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
const PORT = parseInt(process.env.PORT || "4000", 10);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "dev-only-insecure-admin-key";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL — add a Postgres database to this Railway project before starting the server.");
  process.exit(1);
}

const NETWORKS = {
  torox: {
    placementId: process.env.TOROX_PLACEMENT_ID,
    secret: process.env.TOROX_POSTBACK_SECRET,
    params: { userId: "subid", amount: "amount", txnId: "transaction_id", secret: "secret" },
  },
  adgate: {
    placementId: process.env.ADGATE_PLACEMENT_ID,
    secret: process.env.ADGATE_POSTBACK_SECRET,
    params: { userId: "subid", amount: "payout", txnId: "transaction_id", secret: "secret" },
  },
  cpx: {
    placementId: process.env.CPX_APP_ID,
    secret: process.env.CPX_POSTBACK_SECRET,
    params: { userId: "user_id", amount: "amount_local", txnId: "trans_id", secret: "secure_hash" },
  },
};

const VALID_CATEGORIES = ["Social", "Website Visits", "Ad Views", "Games"];

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
  dailyBonusPerDay: 10,
  adFrequencyMin: 2,
  announcement: "Welcome to Task Connect Global! Complete tasks daily to earn more.",
  paymentOptions: ["EasyPaisa", "JazzCash", "Bank Transfer", "PayPal", "Payeer", "Binance"],
  theme: "Purple",
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
async function setSettings(partial) {
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in SETTINGS_DEFAULTS)) continue;
    await dbRun(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)]
    );
  }
  return getAllSettings();
}

// =============================================================================
// POINTS LEDGER
// =============================================================================
async function applyPointsChangeWithClient(client, { userId, points, type, network = null, externalTxnId = null, status = "confirmed", meta = null }) {
  const cq = (text, params = []) => client.query(toPgQuery(text), params);

  if (network && externalTxnId) {
    const existing = (await cq("SELECT id FROM transactions WHERE network = ? AND external_txn_id = ?", [network, externalTxnId])).rows[0];
    if (existing) return { duplicate: true };
  }

  const userRow = (await cq("SELECT points FROM users WHERE id = ?", [userId])).rows[0];
  if (!userRow) throw new Error("User not found");
  const newBalance = userRow.points + points;
  if (newBalance < 0) throw new Error("Insufficient points balance");

  await cq("UPDATE users SET points = ? WHERE id = ?", [newBalance, userId]);
  await cq(
    `INSERT INTO transactions (id, user_id, type, network, external_txn_id, points, status, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), userId, type, network, externalTxnId, points, status, meta ? JSON.stringify(meta) : null]
  );
  return { newBalance };
}

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

async function requireAdminRole(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(401).json({ error: "Invalid or expired token" }); }
  try {
    const user = await dbGet("SELECT role, status FROM users WHERE id = ?", [payload.userId]);
    if (!user) return res.status(401).json({ error: "User not found" });
    if (user.status === "banned") return res.status(403).json({ error: "This account has been suspended" });
    if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    req.userId = payload.userId;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
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

const MAX_PHOTO_DATA_URL_LENGTH = 2_000_000;
app.put("/user/photo", requireAuth, ah(async (req, res) => {
  const { photo } = req.body || {};
  if (photo !== null && typeof photo !== "string") return res.status(400).json({ error: "photo must be a data URL string or null" });
  if (photo && !photo.startsWith("data:image/")) return res.status(400).json({ error: "photo must be an image data URL" });
  if (photo && photo.length > MAX_PHOTO_DATA_URL_LENGTH) return res.status(413).json({ error: "That image is too large — please choose a smaller photo" });
  await dbRun("UPDATE users SET photo = ? WHERE id = ?", [photo, req.userId]);
  res.json({ photo });
}));

app.get("/user/transactions", requireAuth, ah(async (req, res) => {
  const rows = await dbAll("SELECT id, type, network, points, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", [req.userId]);
  res.json({ transactions: rows });
}));

app.get("/user/offerwall-link/:network", requireAuth, ah(async (req, res) => {
  const network = req.params.network;
  const net = NETWORKS[network];
  if (!net) return res.status(404).json({ error: `Unknown network "${network}"` });
  if (!net.placementId) return res.status(503).json({ error: `${network} is not configured yet` });
  let url;
  if (network === "torox") url = `https://torox.io/ifr/show/${net.placementId}/${req.userId}`;
  else if (network === "adgate") url = `https://wall.adgaterewards.com/${net.placementId}?subid=${req.userId}`;
  else if (network === "cpx") url = `https://offers.cpx-research.com/index.php?app_id=${net.placementId}&ext_user_id=${req.userId}`;
  res.json({ url });
}));

// ---------- Settings ----------
app.get("/settings", requireAuth, ah(async (req, res) => res.json(await getAllSettings())));
app.put("/settings", requireAdminRole, ah(async (req, res) => res.json(await setSettings(req.body || {}))));

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

app.post("/tasks", requireAdminRole, ah(async (req, res) => {
  const { title, category, reward, link } = req.body || {};
  if (!title || !category || !reward) return res.status(400).json({ error: "title, category, and reward are required" });
  if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
  if (category === "Website Visits" && !link) return res.status(400).json({ error: "Website Visits tasks require a link" });

  const id = crypto.randomUUID();
  await dbRun(`INSERT INTO tasks (id, title, category, reward, link, active) VALUES (?, ?, ?, ?, ?, 1)`, [id, title, category, parseInt(reward, 10), link || null]);
  res.status(201).json({ task: await dbGet("SELECT * FROM tasks WHERE id = ?", [id]) });
}));

app.put("/tasks/:id", requireAdminRole, ah(async (req, res) => {
  const existing = await dbGet("SELECT * FROM tasks WHERE id = ?", [req.params.id]);
  if (!existing) return res.status(404).json({ error: "Task not found" });
  const { title, category, reward, link } = req.body || {};
  if (category && !VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
  await dbRun(
    `UPDATE tasks SET title = ?, category = ?, reward = ?, link = ? WHERE id = ?`,
    [title ?? existing.title, category ?? existing.category, reward ? parseInt(reward, 10) : existing.reward, link !== undefined ? link : existing.link, req.params.id]
  );
  res.json({ task: await dbGet("SELECT * FROM tasks WHERE id = ?", [req.params.id]) });
}));

app.delete("/tasks/:id", requireAdminRole, ah(async (req, res) => {
  const result = await dbRun("UPDATE tasks SET active = 0 WHERE id = ?", [req.params.id]);
  if (result.changes === 0) return res.status(404).json({ error: "Task not found" });
  res.json({ removed: true });
}));

// ---------- Rewards ----------
app.post("/rewards/claim", requireAuth, ah(async (req, res) => {
  const { type, day, taskId } = req.body || {};

  if (type === "daily_bonus") {
    const perDay = await getSetting("dailyBonusPerDay");
    const streakDay = Math.min(7, Math.max(1, parseInt(day, 10) || 1));
    const points = perDay * streakDay;
    try {
      const result = await applyPointsChange({ userId: req.userId, points, type, meta: { day: streakDay } });
      return res.json({ pointsAwarded: points, newBalance: result.newBalance });
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }

  if (type === "ad_view" || type === "task_proof") {
    if (!taskId) return res.status(400).json({ error: "taskId is required for this reward type" });

    const task = await dbGet("SELECT * FROM tasks WHERE id = ? AND active = 1", [taskId]);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const existingCompletion = await dbGet("SELECT user_id FROM task_completions WHERE user_id = ? AND task_id = ?", [req.userId, taskId]);
    if (existingCompletion) return res.status(400).json({ error: "You have already completed this task" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(toPgQuery(`INSERT INTO task_completions (user_id, task_id) VALUES (?, ?)`), [req.userId, taskId]);
      const resPoints = await applyPointsChangeWithClient(client, {
        userId: req.userId,
        points: task.reward,
        type: type === "ad_view" ? "ad_view" : "task_reward",
        meta: { taskId, title: task.title },
      });
      await client.query("COMMIT");
      return res.json({ pointsAwarded: task.reward, newBalance: resPoints.newBalance });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      return res.status(400).json({ error: e.message });
    } finally {
      client.release();
    }
  }

  res.status(400).json({ error: "Invalid reward type" });
}));

// ---------- Withdrawals ----------
app.post("/withdrawals", requireAuth, ah(async (req, res) => {
  const { amountPoints, gateway, accountNumber } = req.body || {};
  if (!amountPoints || !gateway || !accountNumber) {
    return res.status(400).json({ error: "amountPoints, gateway, and accountNumber are required" });
  }

  const points = parseInt(amountPoints, 10);
  const minPoints = await getSetting("minWithdrawalPoints");
  if (points < minPoints) {
    return res.status(400).json({ error: `Minimum withdrawal amount is ${minPoints} points` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const resPoints = await applyPointsChangeWithClient(client, {
      userId: req.userId,
      points: -points,
      type: "withdrawal",
      meta: { gateway, accountNumber }
    });

    if (resPoints.newBalance < 0) {
      throw new Error("Insufficient points balance");
    }

    const withdrawalId
