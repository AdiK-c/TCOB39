# Notification System Design

---

## Stage 1

### Overview

A campus notification platform where students receive real-time updates for **Placements**, **Events**, and **Results**. The REST API is designed for a logged-in student context — every request is authenticated via a JWT bearer token.

---

### Authentication Header (all routes)

```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

---

### REST API Endpoints

---

#### 1. Get All Notifications

```
GET /api/notifications
```

**Query Parameters (optional):**

| Param | Type | Description |
|-------|------|-------------|
| `type` | string | Filter by `Placement`, `Result`, `Event` |
| `unread` | boolean | `true` returns only unread |
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 20) |

**Request Headers:**
```json
{
  "Authorization": "Bearer <jwt_token>"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
      "type": "Placement",
      "message": "CSX Corporation hiring",
      "isRead": false,
      "timestamp": "2026-04-22T17:51:18Z",
      "createdAt": "2026-04-22T17:51:18Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150
  }
}
```

---

#### 2. Get Single Notification

```
GET /api/notifications/:id
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
    "type": "Placement",
    "message": "CSX Corporation hiring",
    "isRead": false,
    "timestamp": "2026-04-22T17:51:18Z"
  }
}
```

**Response (404 Not Found):**
```json
{
  "success": false,
  "error": "Notification not found"
}
```

---

#### 3. Mark Single Notification as Read

```
PATCH /api/notifications/:id/read
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Notification marked as read",
  "data": {
    "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
    "isRead": true
  }
}
```

---

#### 4. Mark All Notifications as Read

```
PATCH /api/notifications/read-all
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "All notifications marked as read",
  "updatedCount": 42
}
```

---

#### 5. Delete a Notification

```
DELETE /api/notifications/:id
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Notification deleted"
}
```

---

#### 6. Create Notification (Admin / HR only)

```
POST /api/notifications
```

**Request Headers:**
```json
{
  "Authorization": "Bearer <admin_jwt_token>",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "type": "Placement",
  "message": "Google hiring for SDE roles",
  "targetStudentIds": ["student_001", "student_002"],
  "sendEmail": true,
  "sendPush": true
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "message": "Notification created and queued for delivery",
  "notificationId": "new-uuid-here"
}
```

---

#### 7. Bulk Notify All Students (Admin / HR only)

```
POST /api/notifications/notify-all
```

**Request Body:**
```json
{
  "type": "Placement",
  "message": "Campus placement drive on 25th April",
  "sendEmail": true,
  "sendPush": true
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "message": "Bulk notification job queued",
  "jobId": "job-uuid-here",
  "estimatedRecipients": 50000
}
```

> Returns 202 (Accepted) not 200 — bulk delivery is async via a job queue.

---

#### 8. Get Priority Inbox (Top N)

```
GET /api/notifications/priority?top=10
```

**Response (200 OK):**
```json
{
  "success": true,
  "top": 10,
  "data": [
    {
      "id": "uuid",
      "type": "Placement",
      "message": "Google hiring",
      "priorityScore": 398,
      "isRead": false,
      "timestamp": "2026-04-22T17:51:18Z"
    }
  ]
}
```

---

#### 9. Get Unread Count

```
GET /api/notifications/unread-count
```

**Response (200 OK):**
```json
{
  "success": true,
  "unreadCount": 17
}
```

---

### Real-Time Notification Mechanism

**Chosen approach: Server-Sent Events (SSE)**

**Why SSE over WebSockets:**
- Notifications are **server → client only** (students only receive, never send)
- SSE is simpler, works over HTTP/1.1, auto-reconnects
- WebSockets are overkill for one-directional updates
- SSE is natively supported in browsers without extra libraries

**SSE Endpoint:**

```
GET /api/notifications/stream
```

**Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Authorization: Bearer <jwt_token>
```

**Event format sent from server:**
```
event: notification
data: {"id":"uuid","type":"Placement","message":"Google hiring","timestamp":"2026-04-22T17:51:18Z"}

event: ping
data: {}
```

**Flow:**
1. Student logs in → frontend opens SSE connection to `/api/notifications/stream`
2. When HR triggers `notify-all`, server pushes event to all connected SSE clients
3. Frontend receives event → updates badge count and notification list without polling

---

## Stage 2

### Database Choice: PostgreSQL (Relational)

**Why PostgreSQL over NoSQL:**
- Notifications have a **fixed, predictable schema** (ID, type, message, studentID, timestamp, isRead)
- We need **strong consistency** — a student must never miss a notification or see duplicates
- Complex queries are needed: filter by type, sort by date, join with student table
- PostgreSQL handles **50,000 students × 100 notifications = 5M rows** comfortably with proper indexing
- ACID transactions ensure reliable read/unread status updates

---

### DB Schema

```sql
-- Students table
CREATE TABLE students (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  roll_number   VARCHAR(50) UNIQUE NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Notifications master table (one record per notification event)
CREATE TABLE notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              notification_type NOT NULL,
  message           TEXT NOT NULL,
  created_by        UUID REFERENCES students(id),
  created_at        TIMESTAMP DEFAULT NOW()
);

-- Enum for notification type
CREATE TYPE notification_type AS ENUM ('Placement', 'Result', 'Event');

-- Student-Notification mapping (tracks per-student read status)
CREATE TABLE student_notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  notification_id  UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  is_read          BOOLEAN DEFAULT FALSE,
  read_at          TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, notification_id)
);

-- Indexes for performance
CREATE INDEX idx_student_notifications_student_id ON student_notifications(student_id);
CREATE INDEX idx_student_notifications_is_read ON student_notifications(is_read);
CREATE INDEX idx_student_notifications_created_at ON student_notifications(created_at DESC);
CREATE INDEX idx_notifications_type ON notifications(type);
```

---

### Sample Queries Based on Stage 1 APIs

**GET /api/notifications (fetch all for a student):**
```sql
SELECT
  n.id,
  n.type,
  n.message,
  sn.is_read,
  n.created_at
FROM student_notifications sn
JOIN notifications n ON n.id = sn.notification_id
WHERE sn.student_id = $1
ORDER BY n.created_at DESC
LIMIT $2 OFFSET $3;
```

**GET /api/notifications?type=Placement:**
```sql
SELECT n.id, n.type, n.message, sn.is_read, n.created_at
FROM student_notifications sn
JOIN notifications n ON n.id = sn.notification_id
WHERE sn.student_id = $1 AND n.type = 'Placement'
ORDER BY n.created_at DESC;
```

**PATCH /api/notifications/:id/read:**
```sql
UPDATE student_notifications
SET is_read = TRUE, read_at = NOW()
WHERE student_id = $1 AND notification_id = $2;
```

**GET /api/notifications/unread-count:**
```sql
SELECT COUNT(*) FROM student_notifications
WHERE student_id = $1 AND is_read = FALSE;
```

---

### Problems as Data Volume Increases & Solutions

| Problem | Solution |
|---------|----------|
| 5M+ rows slow to query | Indexes on `student_id`, `created_at`, `type` |
| Full table scans | Composite indexes, query EXPLAIN analysis |
| Old notifications slowing queries | Partition table by `created_at` (monthly) |
| Read/write contention | Read replicas for SELECT, primary for writes |
| Bulk inserts for 50k students | Batch INSERT with `INSERT INTO ... VALUES (...), (...)` |

---

## Stage 3

### Query Analysis

```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```

**Is this query accurate?**

The query works logically but has two issues with the schema designed in Stage 2:
- `studentID` and `isRead` belong to `student_notifications`, not `notifications` directly — the schema separates them for scalability
- `SELECT *` fetches all columns including large text fields unnecessarily

**Why is it slow?**

1. **No index on `studentID`** — full table scan across millions of rows
2. **No index on `isRead`** — cannot filter efficiently
3. **No composite index** — even with individual indexes, the DB may not use both optimally
4. **`SELECT *`** — fetches all columns, increases I/O
5. **`ORDER BY createdAt DESC`** — filesort if no index on `createdAt`

**What would you change:**

```sql
-- Step 1: Add composite index (covers the WHERE + ORDER BY in one index)
CREATE INDEX idx_sn_student_unread_date
  ON student_notifications(student_id, is_read, created_at DESC)
  WHERE is_read = FALSE;  -- partial index, only indexes unread rows

-- Step 2: Rewrite the query
SELECT
  n.id,
  n.type,
  n.message,
  n.created_at
FROM student_notifications sn
JOIN notifications n ON n.id = sn.notification_id
WHERE sn.student_id = 1042
  AND sn.is_read = FALSE
ORDER BY n.created_at DESC;
```

**Computation cost after fix:**
- Before: O(N) full scan → potentially millions of rows
- After: O(log N) index lookup → only that student's unread rows

---

### "Index Every Column" Advice — Is It Safe?

**No, this is not safe advice.**

Adding indexes on every column causes:

| Problem | Explanation |
|---------|-------------|
| **Slow writes** | Every INSERT/UPDATE/DELETE must update all indexes |
| **Storage bloat** | Each index is a separate B-tree data structure on disk |
| **Query planner confusion** | Postgres may choose wrong index with too many options |
| **Maintenance overhead** | VACUUM and ANALYZE take longer |

**Correct approach:** Index only columns used in `WHERE`, `JOIN`, and `ORDER BY` clauses. Use `EXPLAIN ANALYZE` to find slow queries, then add targeted indexes.

---

### Query: Students Who Got a Placement Notification in Last 7 Days

```sql
SELECT DISTINCT
  s.id,
  s.name,
  s.email,
  s.roll_number
FROM students s
JOIN student_notifications sn ON sn.student_id = s.id
JOIN notifications n ON n.id = sn.notification_id
WHERE
  n.type = 'Placement'
  AND n.created_at >= NOW() - INTERVAL '7 days'
ORDER BY s.name;
```

---

## Stage 4

### Problem

Notifications are fetched from the database on every page load for every student. With 50,000 students, this creates:
- Thundering herd: all students loading the app at 9am hit DB simultaneously
- Repeated identical queries for the same student refreshing the page
- Read-heavy load on a write-optimized primary DB

---

### Solutions

---

**Strategy 1: Redis Caching (Recommended)**

Cache each student's notification list in Redis with a TTL.

```
Key:   notifications:student:{studentId}
Value: JSON array of notifications
TTL:   60 seconds
```

Flow:
1. Request comes in → check Redis first
2. Cache hit → return instantly, no DB query
3. Cache miss → query DB → store in Redis → return to client
4. On new notification → invalidate that student's cache key

**Tradeoffs:**
- ✅ Dramatically reduces DB load (cache hit ratio ~90%+ for active users)
- ✅ Sub-millisecond response from Redis
- ❌ Students may see slightly stale notifications (max 60s delay)
- ❌ Added infrastructure complexity (Redis cluster)
- ❌ Cache invalidation must be carefully managed on new notification delivery

---

**Strategy 2: Read Replicas**

Route all `SELECT` queries to a PostgreSQL read replica, keep writes on primary.

**Tradeoffs:**
- ✅ No code logic change, just connection routing
- ✅ Distributes read load across multiple nodes
- ❌ Replication lag (replica may be 100-500ms behind primary)
- ❌ Does not help with redundant identical queries (same student refreshing)

---

**Strategy 3: Pagination + Lazy Loading**

Instead of loading all notifications, load only the first 20 on page load. Load more on scroll.

**Tradeoffs:**
- ✅ Reduces data transferred per request dramatically
- ✅ No extra infrastructure
- ❌ UX requires infinite scroll or "load more" button
- ❌ Doesn't reduce query count, only query size

---

**Strategy 4: Unread Count Cache**

The most common operation is displaying the unread badge count. Cache only this number.

```
Key: unread_count:student:{studentId}
TTL: 30 seconds
```

Invalidate when a notification is delivered or read. This avoids fetching the full notification list just to show "17 unread."

---

**Recommended combined approach:**
- Redis for notification list cache (TTL 60s)
- Read replica for heavy analytical queries
- Pagination (limit 20 per page) to reduce payload

---

## Stage 5

### Problems with Current Implementation

```
function notify_all(student_ids: array, message: string):
  for student_id in student_ids:
    send_email(student_id, message)   # synchronous, blocks
    save_to_db(student_id, message)   # only runs if email succeeded
    push_to_app(student_id, message)  # only runs if DB succeeded
```

| Problem | Explanation |
|---------|-------------|
| **Sequential processing** | 50,000 students processed one by one — extremely slow |
| **No atomicity** | If email fails at student 200, DB save never happens for that student |
| **Tight coupling** | Email failure blocks DB save and push |
| **No retry logic** | Failed deliveries are silently dropped |
| **No partial failure handling** | One failure can halt entire operation |
| **Synchronous** | HTTP request blocks until all 50k are processed — timeout risk |

---

### Should email save and DB save happen together?

**No — they should be decoupled.**

Email delivery is an external, unreliable operation. DB save is internal and reliable. Coupling them means an email provider outage prevents notifications from being saved at all — students would never see the notification even in-app.

**Correct approach:** Save to DB first (reliable), then queue email and push as independent async jobs.

---

### Redesigned Pseudocode

```
function notify_all(student_ids: array, message: string):

  // Step 1: Save all notifications to DB in a single batch insert
  // Fast, atomic, reliable
  batch_insert_notifications(student_ids, message)  # single SQL transaction

  // Step 2: Push SSE events to all currently connected students
  // Non-blocking, best-effort
  for each connected_student in sse_connections:
    push_sse_event(connected_student, message)  # async, fire and forget

  // Step 3: Enqueue email and push jobs — do NOT send inline
  // Queue handles retries, failures, backpressure
  for student_id in student_ids (in batches of 500):
    enqueue_job("send_email", { student_id, message, retry: 3 })
    enqueue_job("send_push",  { student_id, message, retry: 3 })

  return { status: "queued", jobId: uuid, recipients: len(student_ids) }


// Worker processes (run independently, horizontally scalable)
worker process_email_job(job):
  result = send_email(job.student_id, job.message)
  if result.failed AND job.attempts < job.retry:
    requeue_with_backoff(job)
  else if result.failed:
    log_failed_delivery(job.student_id, "email")


worker process_push_job(job):
  result = push_to_app(job.student_id, job.message)
  if result.failed AND job.attempts < job.retry:
    requeue_with_backoff(job)
  else if result.failed:
    log_failed_delivery(job.student_id, "push")
```

**Key improvements:**
- DB save is decoupled from email — always succeeds first
- Email and push are async queue jobs (use BullMQ / RabbitMQ)
- Batch processing in groups of 500 prevents queue overflow
- Each job has retry with exponential backoff
- Failed deliveries are logged, not silently dropped
- Returns immediately (202 Accepted) — doesn't block the HTTP request

---

## Stage 6

### Priority Inbox Design

#### Priority Scoring Formula

Each notification receives a score based on two factors:

```
priorityScore = typeWeight + recencyScore

typeWeight:
  Placement → 300
  Result    → 200
  Event     → 100

recencyScore:
  = max(0, 100 - minutesSincePosted)
  Notifications posted within 100 minutes get a recency bonus
  Older notifications get 0 recency bonus
```

This ensures Placements always outrank Results and Events, but a very recent Event can outrank an older Result if the weights are close.

---

#### Efficient Top-N with Max-Heap

For static fetch (API call once):
- Fetch all notifications
- Score each one
- Use a **Min-Heap of size N** — push each notification, pop if heap exceeds N
- Result: O(M log N) time where M = total notifications, N = top count
- Far more efficient than sorting all M notifications: O(M log M)

For streaming new notifications:
- Maintain the heap in memory
- When a new notification arrives via SSE/WebSocket:
  - Score it
  - If score > heap minimum → replace minimum, re-heapify
  - O(log N) per new notification — no full re-sort needed

---

#### API Endpoint

```
GET /api/notifications/priority?top=10
```

Response:
```json
{
  "success": true,
  "top": 10,
  "data": [
    {
      "id": "uuid",
      "type": "Placement",
      "message": "Google hiring",
      "priorityScore": 398,
      "timestamp": "2026-04-22T17:51:18Z"
    }
  ]
}
```
