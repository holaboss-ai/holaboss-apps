-- Seed fixtures for the Reddit monitoring dashboards.
--
-- Drops a mix of post lifecycle states into the workspace's data.db
-- so the internal + external dashboards have real-looking data
-- without hitting the Reddit API. Apply via:
--
--   sqlite3 ~/.holaboss-desktop/sandbox-host/workspace/<id>/.holaboss/data.db \
--     < hola-boss-apps/reddit/scripts/seed-monitoring-fixtures.sql
--
-- Re-running is idempotent (DELETE-then-INSERT for the seeded ids).
-- Real tracked posts (those with non-seed ids) are untouched.

BEGIN;

-- Wipe just our seed rows.
DELETE FROM reddit_post_metrics WHERE post_id LIKE 'seed-%';
DELETE FROM reddit_posts        WHERE id      LIKE 'seed-%';

-- ─── Post 1 — mid-window, 6 of 12 snapshots captured ────────────
INSERT INTO reddit_posts
  (id, title, content, subreddit, status, external_post_id, source_url,
   monitoring_started_at, published_at, created_at, updated_at)
VALUES
  ('seed-active-01',
   'Show: holaOS — agent environment for long-horizon work',
   '',
   'SideProject',
   'published',
   'seedabc1',
   'https://www.reddit.com/r/SideProject/comments/seedabc1/show_holaos/',
   datetime('now', '-23 hours'),
   datetime('now', '-23 hours'),
   datetime('now', '-23 hours'),
   datetime('now'));

INSERT INTO reddit_post_metrics (post_id, captured_at, score, num_comments, upvote_ratio, milestone_idx, raw)
VALUES
  ('seed-active-01', datetime('now', '-23 hours'),  12,  1, 0.92, 0, '{}'),
  ('seed-active-01', datetime('now', '-19 hours'),  34,  4, 0.93, 1, '{}'),
  ('seed-active-01', datetime('now', '-15 hours'),  78, 12, 0.94, 2, '{}'),
  ('seed-active-01', datetime('now', '-11 hours'), 145, 28, 0.95, 3, '{}'),
  ('seed-active-01', datetime('now',  '-7 hours'), 220, 41, 0.94, 4, '{}'),
  ('seed-active-01', datetime('now',  '-3 hours'), 268, 53, 0.93, 5, '{}');

-- ─── Post 2 — completed (48h elapsed), final values frozen ──────
INSERT INTO reddit_posts
  (id, title, content, subreddit, status, external_post_id, source_url,
   monitoring_started_at, monitoring_completed_at, published_at,
   final_score, final_num_comments, final_upvote_ratio,
   created_at, updated_at)
VALUES
  ('seed-completed-01',
   'I built an agent OS in TypeScript — here is what shipping looked like',
   '',
   'LocalLLaMA',
   'published',
   'seedabc2',
   'https://www.reddit.com/r/LocalLLaMA/comments/seedabc2/agent_os_in_ts/',
   datetime('now', '-49 hours'),
   datetime('now',  '-1 hours'),
   datetime('now', '-49 hours'),
   1842,
   217,
   0.91,
   datetime('now', '-49 hours'),
   datetime('now'));

INSERT INTO reddit_post_metrics (post_id, captured_at, score, num_comments, upvote_ratio, milestone_idx, raw)
VALUES
  ('seed-completed-01', datetime('now', '-49 hours'),   30,   2, 0.95, 0,  '{}'),
  ('seed-completed-01', datetime('now', '-45 hours'),  125,   9, 0.94, 1,  '{}'),
  ('seed-completed-01', datetime('now', '-41 hours'),  290,  22, 0.93, 2,  '{}'),
  ('seed-completed-01', datetime('now', '-37 hours'),  510,  46, 0.92, 3,  '{}'),
  ('seed-completed-01', datetime('now', '-33 hours'),  780,  78, 0.92, 4,  '{}'),
  ('seed-completed-01', datetime('now', '-29 hours'),  990, 102, 0.92, 5,  '{}'),
  ('seed-completed-01', datetime('now', '-25 hours'), 1200, 128, 0.91, 6,  '{}'),
  ('seed-completed-01', datetime('now', '-21 hours'), 1400, 152, 0.91, 7,  '{}'),
  ('seed-completed-01', datetime('now', '-17 hours'), 1580, 175, 0.91, 8,  '{}'),
  ('seed-completed-01', datetime('now', '-13 hours'), 1720, 195, 0.91, 9,  '{}'),
  ('seed-completed-01', datetime('now',  '-9 hours'), 1810, 209, 0.91, 10, '{}'),
  ('seed-completed-01', datetime('now',  '-5 hours'), 1842, 217, 0.91, 11, '{}');

-- ─── Post 3 — completed AND has views entered ──────────────────
INSERT INTO reddit_posts
  (id, title, content, subreddit, status, external_post_id, source_url,
   monitoring_started_at, monitoring_completed_at, published_at,
   final_score, final_num_comments, final_upvote_ratio, views,
   created_at, updated_at)
VALUES
  ('seed-completed-02',
   'Lessons from running 50+ AI agents on the same workspace',
   '',
   'agentic',
   'published',
   'seedabc3',
   'https://www.reddit.com/r/agentic/comments/seedabc3/lessons_from_50_agents/',
   datetime('now', '-72 hours'),
   datetime('now', '-24 hours'),
   datetime('now', '-72 hours'),
   523,
   89,
   0.87,
   42100,
   datetime('now', '-72 hours'),
   datetime('now'));

INSERT INTO reddit_post_metrics (post_id, captured_at, score, num_comments, upvote_ratio, milestone_idx, raw)
VALUES
  ('seed-completed-02', datetime('now', '-72 hours'),   8,   0, 1.00, 0,  '{}'),
  ('seed-completed-02', datetime('now', '-68 hours'),  42,   3, 0.95, 1,  '{}'),
  ('seed-completed-02', datetime('now', '-64 hours'),  98,  12, 0.92, 2,  '{}'),
  ('seed-completed-02', datetime('now', '-60 hours'), 175,  24, 0.90, 3,  '{}'),
  ('seed-completed-02', datetime('now', '-56 hours'), 245,  37, 0.89, 4,  '{}'),
  ('seed-completed-02', datetime('now', '-52 hours'), 305,  48, 0.88, 5,  '{}'),
  ('seed-completed-02', datetime('now', '-48 hours'), 360,  58, 0.88, 6,  '{}'),
  ('seed-completed-02', datetime('now', '-44 hours'), 410,  67, 0.87, 7,  '{}'),
  ('seed-completed-02', datetime('now', '-40 hours'), 450,  74, 0.87, 8,  '{}'),
  ('seed-completed-02', datetime('now', '-36 hours'), 480,  80, 0.87, 9,  '{}'),
  ('seed-completed-02', datetime('now', '-32 hours'), 505,  85, 0.87, 10, '{}'),
  ('seed-completed-02', datetime('now', '-28 hours'), 523,  89, 0.87, 11, '{}');

-- ─── Post 4 — removed mid-window by mod ────────────────────────
INSERT INTO reddit_posts
  (id, title, content, subreddit, status, external_post_id, source_url,
   monitoring_started_at, deleted_at, deleted_reason, deleted_reason_raw,
   published_at, created_at, updated_at)
VALUES
  ('seed-removed-01',
   'Self-promo without context — got nuked',
   '',
   'programming',
   'published',
   'seedabc4',
   'https://www.reddit.com/r/programming/comments/seedabc4/self_promo/',
   datetime('now', '-30 hours'),
   datetime('now', '-22 hours'),
   'mod_removed',
   'moderator',
   datetime('now', '-30 hours'),
   datetime('now', '-30 hours'),
   datetime('now'));

INSERT INTO reddit_post_metrics (post_id, captured_at, score, num_comments, upvote_ratio, milestone_idx, raw)
VALUES
  ('seed-removed-01', datetime('now', '-30 hours'),  3, 0, 0.83, 0, '{}'),
  ('seed-removed-01', datetime('now', '-26 hours'), 18, 4, 0.71, 1, '{}'),
  ('seed-removed-01', datetime('now', '-22 hours'), 22, 6, 0.62, 2, '{}');

-- ─── Post 5 — fresh, only milestone 0 captured (just registered) ─
INSERT INTO reddit_posts
  (id, title, content, subreddit, status, external_post_id, source_url,
   monitoring_started_at, published_at, created_at, updated_at)
VALUES
  ('seed-fresh-01',
   'Built a 48h Reddit post analytics tracker',
   '',
   'analytics',
   'published',
   'seedabc5',
   'https://www.reddit.com/r/analytics/comments/seedabc5/48h_tracker/',
   datetime('now', '-15 minutes'),
   datetime('now', '-15 minutes'),
   datetime('now', '-15 minutes'),
   datetime('now'));

INSERT INTO reddit_post_metrics (post_id, captured_at, score, num_comments, upvote_ratio, milestone_idx, raw)
VALUES
  ('seed-fresh-01', datetime('now', '-10 minutes'), 2, 0, 1.00, 0, '{}');

COMMIT;

-- After running, two dashboards should show:
--
--   reddit-monitoring-internal.dashboard
--   ├── Active monitoring:        2  (seed-active-01, seed-fresh-01)
--   ├── Completed (48h passed):   2  (seed-completed-01, seed-completed-02)
--   ├── Removed during window:    1  (seed-removed-01)
--   └── Snapshots captured:      34
--
--   reddit-monitoring-external.dashboard
--   ├── Posts in summary:         2
--   ├── Awaiting Views entry:     1  (seed-completed-01 — no views yet)
--   ├── External summary table:   1 row visible (seed-completed-02 has views)
--   └── Removed during window:    1
