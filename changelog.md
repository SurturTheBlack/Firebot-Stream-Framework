# Changelog - Stream Session Framework

All notable changes for the stream session + stream streak solution are documented here.

This changelog covers only the newly generated scripts:

- stream-session-store.js
- stream-backend.js

## [0.1.0] - 2026-06-27 (Pre-release Base)

### Core Session & Attendance

- stream-session-store.js
  - SQLite database at ../db/stream-db.sqlite with WAL mode for reliability
  - stream_sessions table with session lifecycle (create, end, resume)
  - stream_viewers table for per-stream attendance tracking
  - Session ID generation with timestamp-based uniqueness
  - Viewer attendance recording and streak calculation logic
  - Startup prompt support via Firebot frontend modal bridge

- stream-backend.js
  - Unified startup-only backend (replaces fragmented script approach)
  - Registers `$streamStreak[username, field]` replace variable for stat lookups
  - Registers `$streamSession[field]` replace variable for session context
  - Registers `surtur:stream-streak-mark` native effect for attendance marking
  - Registers `surtur:stream-session-control` native effect for lifecycle management
  - Runs interactive startup bootstrap (new/resume/end prompt)
  - Event listeners for Twitch events (follows, subs, game changes)

### Streak Statistics

- stream-streak.firebotsetup
  - `!streak` command: public display of viewer's current streak
  - `!streakme` command: whisper with personal stats
  - `!streakmark` command: manual attendance mark
  - viewer-arrived event: automatic attendance tracking
  - Calculates: streamstreak, totalstreams, longeststreamstreak

### Enhanced Metrics Tracking

**Game Changes Tracking**
- stream_games table: logs every game change with timestamp
- Hooked to twitch:game-changed event for automatic logging
- Supports multiple games per stream session

**Per-Viewer Watch Time**
- New columns: viewtime_minutes_at_arrival, viewtime_minutes_at_end
- Captures view time from Firebot userDatabase at arrival
- Finalizes view time when session ends
- Enables viewer engagement measurement

**Stream Metadata**
- New columns: title, new_followers_count, new_subs_count
- Title captured at session start from Twitch channel info
- Follow count incremented on twitch:follow event
- Sub count incremented on twitch:sub / twitch:resub / twitch:gift-sub events
- Provides stream-level conversion and growth metrics

**Viewer Snapshots**
- New columns: was_subscriber, was_follower
- Captured as boolean snapshot at viewer first arrival
- Preserves viewer status independent of later account changes
- Enables historical viewer segment analysis

### Session Control Commands

- session-controls.firebotsetup
  - `!sessionstatus`: read current session ID and timing
  - `!sessionnew`: end current session and start fresh
  - `!sessionresume`: continue existing session or create if needed
  - `!sessionend`: finalize current session (finalize all viewer watchtimes)
  - Mod/broadcaster restricted for safety

## Versioning

- 0.1.0 is the pre-release base version. No previous releases.
- Next increment: 0.2.0 for backward-compatible additions, 0.1.1 for fixes.
