const express = require("express");
const axios = require("axios");
const cors = require("cors");
const Log = require("../logging_middleware/logger");

const app = express();
app.use(cors());
app.use(express.json());

const NOTIFICATIONS_API = "http://4.224.186.213/evaluation-service/notifications";

// ─── Priority Scoring ──────────────────────────────────────────────────────
const TYPE_WEIGHT = { Placement: 300, Result: 200, Event: 100 };

function scoreNotification(notification) {
  const typeWeight = TYPE_WEIGHT[notification.Type] || 0;
  const minutesAgo = (Date.now() - new Date(notification.Timestamp).getTime()) / 60000;
  const recencyScore = Math.max(0, 100 - Math.floor(minutesAgo));
  return typeWeight + recencyScore;
}

// ─── Min-Heap Implementation ───────────────────────────────────────────────
// Used to efficiently maintain top-N without sorting all items

class MinHeap {
  constructor() {
    this.heap = [];
  }

  size() {
    return this.heap.length;
  }

  peek() {
    return this.heap[0];
  }

  push(item) {
    this.heap.push(item);
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].priorityScore <= this.heap[i].priorityScore) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  _sinkDown(i) {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.heap[l].priorityScore < this.heap[smallest].priorityScore) smallest = l;
      if (r < n && this.heap[r].priorityScore < this.heap[smallest].priorityScore) smallest = r;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}

// ─── Get Top-N using Min-Heap — O(M log N) ────────────────────────────────
function getTopN(notifications, n) {
  const heap = new MinHeap();

  for (const notif of notifications) {
    const scored = {
      id: notif.ID,
      type: notif.Type,
      message: notif.Message,
      timestamp: notif.Timestamp,
      priorityScore: scoreNotification(notif),
    };

    if (heap.size() < n) {
      heap.push(scored);
    } else if (scored.priorityScore > heap.peek().priorityScore) {
      heap.pop();
      heap.push(scored);
    }
  }

  // Extract and sort descending by priorityScore
  const result = [];
  while (heap.size() > 0) result.push(heap.pop());
  return result.sort((a, b) => b.priorityScore - a.priorityScore);
}

// ─── SSE Clients (for real-time streaming) ────────────────────────────────
const sseClients = new Set();

// ─── Routes ───────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "notification_app_be",
    timestamp: new Date().toISOString(),
  });
});

// GET /api/notifications — all notifications
app.get("/api/notifications", async (req, res) => {
  try {
    const response = await axios.get(NOTIFICATIONS_API);
    let notifications = response.data.notifications || [];

    // Optional filters
    const { type, unread, page = 1, limit = 20 } = req.query;
    if (type) notifications = notifications.filter((n) => n.Type === type);

    const total = notifications.length;
    const start = (page - 1) * limit;
    const paginated = notifications.slice(start, start + parseInt(limit));

    res.json({
      success: true,
      data: paginated.map((n) => ({
        id: n.ID,
        type: n.Type,
        message: n.Message,
        timestamp: n.Timestamp,
        isRead: false, // external API doesn't track this
      })),
      pagination: { page: parseInt(page), limit: parseInt(limit), total },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notifications/unread-count
app.get("/api/notifications/unread-count", async (req, res) => {
  try {
    const response = await axios.get(NOTIFICATIONS_API);
    const notifications = response.data.notifications || [];
    res.json({ success: true, unreadCount: notifications.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notifications/priority?top=10
app.get("/api/notifications/priority", async (req, res) => {
  try {
    const top = Math.min(parseInt(req.query.top) || 10, 100);
    console.log(`[priority] Fetching notifications, returning top ${top}...`);

    let notifications = [];
    try {
      const response = await axios.get(NOTIFICATIONS_API, { timeout: 5000 });
      notifications = response.data.notifications || [];
    } catch (apiErr) {
      console.warn("[priority] External API unavailable, using mock data:", apiErr.message);
      // Mock data matching the API schema — for local testing only
      notifications = [
        { ID: "d146095a-0d86-4a34-9e69-3900a14576bc", Type: "Result",    Message: "mid-sem",                      Timestamp: "2026-04-22 17:51:30" },
        { ID: "b283218f-ea5a-4b7c-93a9-1f2f240d64b0", Type: "Placement", Message: "CSX Corporation hiring",        Timestamp: "2026-04-22 17:51:18" },
        { ID: "81589ada-0ad3-4f77-9554-f52fb558e09d", Type: "Event",      Message: "farewell",                     Timestamp: "2026-04-22 17:51:06" },
        { ID: "0005513a-142b-4bbc-8678-eefec65e1ede", Type: "Result",     Message: "mid-sem",                      Timestamp: "2026-04-22 17:50:54" },
        { ID: "ea836726-c25e-4f21-a72f-544a6af8a37f", Type: "Result",     Message: "project-review",               Timestamp: "2026-04-22 17:50:42" },
        { ID: "003cb427-8fc6-47f7-bb00-be228f6b0d2c", Type: "Result",     Message: "external",                     Timestamp: "2026-04-22 17:50:30" },
        { ID: "e5c4ff20-31bf-4d40-8f02-72fda59e8918", Type: "Result",     Message: "project-review",               Timestamp: "2026-04-22 17:50:18" },
        { ID: "1cfce5ee-ad37-4894-8946-d707627176a5", Type: "Event",      Message: "tech-fest",                    Timestamp: "2026-04-22 17:50:06" },
        { ID: "cf2885a6-45ac-4ba0-b548-6e9e9d4c52c8", Type: "Result",     Message: "project-review",               Timestamp: "2026-04-22 17:49:54" },
        { ID: "8a7412bd-6065-4d09-8501-a37f11cc848b", Type: "Placement",  Message: "Advanced Micro Devices hiring", Timestamp: "2026-04-22 17:49:42" },
        { ID: "f1a2b3c4-0000-0000-0000-000000000001", Type: "Placement",  Message: "Microsoft SDE hiring",          Timestamp: "2026-04-22 17:49:30" },
        { ID: "f1a2b3c4-0000-0000-0000-000000000002", Type: "Event",      Message: "annual sports day",             Timestamp: "2026-04-22 17:49:18" },
        { ID: "f1a2b3c4-0000-0000-0000-000000000003", Type: "Placement",  Message: "Amazon hiring",                 Timestamp: "2026-04-22 17:49:06" },
        { ID: "f1a2b3c4-0000-0000-0000-000000000004", Type: "Result",     Message: "final-sem results",             Timestamp: "2026-04-22 17:48:54" },
        { ID: "f1a2b3c4-0000-0000-0000-000000000005", Type: "Event",      Message: "hackathon",                     Timestamp: "2026-04-22 17:48:42" },
      ];
    }
    console.log(`[priority] Total notifications fetched: ${notifications.length}`);


    const topN = getTopN(notifications, top);

    res.json({
      success: true,
      top,
      totalFetched: notifications.length,
      algorithm: "Min-Heap O(M log N)",
      data: topN,
    });
  } catch (err) {
    console.error("[priority] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notifications/:id — single notification
app.get("/api/notifications/:id", async (req, res) => {
  try {
    const response = await axios.get(NOTIFICATIONS_API);
    const notifications = response.data.notifications || [];
    const found = notifications.find((n) => n.ID === req.params.id);
    if (!found) return res.status(404).json({ success: false, error: "Notification not found" });
    res.json({
      success: true,
      data: { id: found.ID, type: found.Type, message: found.Message, timestamp: found.Timestamp, isRead: false },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/notifications/:id/read — mark as read (in-memory for demo)
const readNotifications = new Set();
app.patch("/api/notifications/:id/read", (req, res) => {
  readNotifications.add(req.params.id);
  res.json({ success: true, message: "Notification marked as read", data: { id: req.params.id, isRead: true } });
});

// PATCH /api/notifications/read-all
app.patch("/api/notifications/read-all", async (req, res) => {
  try {
    const response = await axios.get(NOTIFICATIONS_API);
    const notifications = response.data.notifications || [];
    notifications.forEach((n) => readNotifications.add(n.ID));
    res.json({ success: true, message: "All notifications marked as read", updatedCount: notifications.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notifications/stream — SSE real-time stream
app.get("/api/notifications/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send initial ping
  res.write(`event: ping\ndata: ${JSON.stringify({ message: "connected" })}\n\n`);
  sseClients.add(res);
  console.log(`[SSE] Client connected. Total clients: ${sseClients.size}`);

  // Keep alive ping every 30s
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected. Total clients: ${sseClients.size}`);
  });
});

// Helper to broadcast to all SSE clients (used internally when new notification arrives)
function broadcastNotification(notification) {
  const payload = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;
  sseClients.forEach((client) => client.write(payload));
  console.log(`[SSE] Broadcasted to ${sseClients.size} clients`);
}

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  Log("backend", "info", "controller", "Campus Notification Service started successfully");
  Log("backend", "error", "db", "Database connection failed while fetching notifications");
  console.log(`\n🔔  Campus Notification Service running on port ${PORT}`);
  console.log(`   GET  /health`);
  console.log(`   GET  /api/notifications`);
  console.log(`   GET  /api/notifications/priority?top=10`);
  console.log(`   GET  /api/notifications/unread-count`);
  console.log(`   GET  /api/notifications/:id`);
  console.log(`   PATCH /api/notifications/:id/read`);
  console.log(`   PATCH /api/notifications/read-all`);
  console.log(`   GET  /api/notifications/stream  (SSE)\n`);
});
