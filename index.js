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
