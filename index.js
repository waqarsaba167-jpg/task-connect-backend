const express = require('express');
const app = express();

app.use(express.json());

// Initial tasks list with multiple categories (Social, Gaming, Math, Spin)
let tasks = [
  { id: "1", title: "Follow YouTube Channel", category: "YouTube", reward: 100, link: "https://youtube.com" },
  { id: "2", title: "Watch TikTok Viral Video", category: "TikTok", reward: 80, link: "https://tiktok.com" },
  { id: "3", title: "Play Cyberpunk RPG (Gaming)", category: "Gaming", reward: 200, link: "#" },
  { id: "4", title: "Solve Math Puzzle: 15 + 25 = ?", category: "Math", reward: 50, link: "#" },
  { id: "5", title: "Spin the Lucky Wheel", category: "Spin", reward: 150, link: "#" }
];

// In-memory settings storage
let appSettings = {};

// Admin Task Creation API (Supports all categories)
app.post('/admin/tasks', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  const { title, category, reward, link } = req.body;
  if (!title || !reward) return res.status(400).json({ error: "Title and reward required" });

  const newTask = {
    id: Date.now().toString(),
    title,
    category: category || "General", // YouTube, TikTok, Instagram, Twitter, Telegram, Gaming, Math, Spin etc.
    reward: parseInt(reward),
    link: link || "#"
  };
  tasks.push(newTask);
  res.json({ success: true, task: newTask });
});

let chatMessages = [
  { id: "1", name: "System", text: "Welcome to Task Connect Community Chat!" }
];

// Get Chat Messages
app.get('/chat/messages', authenticateToken, (req, res) => {
  res.json({ success: true, messages: chatMessages });
});

// Send Chat Message with Strict Anti-Spam & Warning System
app.post('/chat/messages', authenticateToken, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Message cannot be empty" });

  // Check for links or phone numbers (spam protection)
  const hasLink = text.includes("http") || text.includes("www") || text.includes(".com") || text.includes(".net");
  const hasPhoneNumber = /\d{10,}/.test(text); // Checks if there are 10 or more continuous digits

  if (hasLink || hasPhoneNumber) {
    // Return automated warning message from System
    return res.status(400).json({ 
      error: "⚠️ Warning: Links and phone numbers are not allowed! If you do this again, your account will be blocked." 
    });
  }

  const newMsg = {
    id: Date.now().toString(),
    name: req.user.name || "User",
    text
  };
  chatMessages.push(newMsg);
  res.json({ success: true, message: newMsg });
});

// Admin: Add or Update Any Custom Setting Dynamically
app.post('/admin/custom-setting', authenticateToken, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Access denied" });
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "Setting key is required" });

  // Save dynamically into appSettings object
  appSettings[key] = value;
  res.json({ success: true, message: `Setting '${key}' updated successfully!`, settings: appSettings });
});

// Authentication middleware definition
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: "Token missing" });
  // Add token verification logic here
  req.user = { role: "admin", name: "AdminUser" }; 
  next();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});// Root route so browser shows a friendly welcome message instead of Cannot GET /
app.get('/', (req, res) => {
  res.json({ success: true, message: "Task Connect Backend is Live and Running!" });
});
