// Initial tasks list with multiple categories (Social, Gaming, Math, Spin)
let tasks = [
  { id: "1", title: "Follow YouTube Channel", category: "YouTube", reward: 100, link: "https://youtube.com" },
  { id: "2", title: "Watch TikTok Viral Video", category: "TikTok", reward: 80, link: "https://tiktok.com" },
  { id: "3", title: "Play Cyberpunk RPG (Gaming)", category: "Gaming", reward: 200, link: "#" },
  { id: "4", title: "Solve Math Puzzle: 15 + 25 = ?", category: "Math", reward: 50, link: "#" },
  { id: "5", title: "Spin the Lucky Wheel", category: "Spin", reward: 150, link: "#" }
];

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
