# Stream Session Framework (Firebot Scripts)

This README documents only the scripts added for the stream session + stream streak solution.

## Included Scripts

- stream-session-store.js
- stream-backend.js

## Purpose

This script set provides:

- A per-stream unique ID lifecycle
- SQLite persistence in the Firebot profile root
- Startup prompt for stream session action (new/resume/end)
- Manual session control (new/resume/end/status)
- Viewer attendance logging per stream
- Native Firebot backend variable registration for streak lookups
- Native Firebot backend effect for attendance marking
- Streak calculations per user:
  - streamstreak (current consecutive streams)
  - totalstreams (all streams attended)
  - longeststreamstreak (best consecutive streak)

## Data Storage

Database file:

- ../db/stream-db.sqlite (relative to scripts folder)

Tables used:

**stream_sessions**
- id (primary key)
- stream_id (unique)
- started_at (ISO timestamp)
- ended_at (ISO timestamp, nullable)
- source (trigger source: startup, effect, etc.)
- notes (optional session notes)
- title (stream title/game name, nullable)
- new_followers_count (incremented on follows during session)
- new_subs_count (incremented on subs/resubs during session)

**stream_viewers**
- stream_id (foreign key)
- username (normalized, lowercase)
- first_seen_at (ISO timestamp of initial attendance)
- viewtime_minutes_at_arrival (capture at attendance, nullable)
- viewtime_minutes_at_end (finalized at session end, nullable)
- was_subscriber (boolean snapshot at arrival)
- was_follower (boolean snapshot at arrival)
- composite primary key: (stream_id, username)

**stream_games**
- id (primary key)
- stream_id (foreign key)
- game_name (Twitch game name, nullable)
- game_id (Twitch game ID, nullable)
- started_at (ISO timestamp when game started)

## Script Details

### stream-session-store.js
Shared helper module for all framework scripts.

Responsibilities:

- Initialize SQLite tables and indexes
- Create/end/find active stream sessions
- Normalize prompt choice values
- Open startup prompt using Firebot frontend modal bridge
- Record viewer attendance for active stream
- Calculate user streak stats across ordered stream history

### stream-backend.js
Unified startup-only backend script. Runs the session bootstrap prompt and registers all variables and effects.

Behavior:

- Registers `$streamStreak[username, field]` replace variable
- Registers `surtur:stream-streak-mark` effect type for attendance marking
- Uses stream-session-store.js for persistence and stat calculation

Variable fields:

- username
- streamstreak
- totalstreams
- longeststreamstreak
- json

Effect parameters:

- username (optional)
- writeCustomVariables (default: true)
- variablePrefix (default: streamstreak_)

Effect outputs:

- username
- streamstreak
- totalstreams
- longeststreamstreak
- recordedForActiveStream

## Automatic Event Tracking

The backend automatically listens for and logs the following Twitch events during an active stream session:

**Game Changes**
- Event: `twitch:game-changed`
- Logs each game change to stream_games table with timestamp
- Captures game_name and game_id

**Viewer Engagement Snapshots**
- When viewer first arrives (via `surtur:stream-streak-mark` effect)
- Captures: was_subscriber, was_follower, viewtime_minutes_at_arrival
- Stored in stream_viewers for segment analysis

**Stream Growth Metrics**
- Event: `twitch:follow` → increments stream_sessions.new_followers_count
- Event: `twitch:sub` → increments stream_sessions.new_subs_count
- Event: `twitch:resub` → increments stream_sessions.new_subs_count
- Event: `twitch:gift-sub` → increments stream_sessions.new_subs_count

**Session Finalization**
- On session end via `surtur:stream-session-control` effect
- Captures final viewtime_minutes_at_end for all active viewers
- Queried from userDatabase.getUserById() for accuracy

## Custom Variable Naming

When variable writing is enabled, backend streak marking uses:

- <prefix><sanitized_username>_streamstreak
- <prefix><sanitized_username>_totalstreams
- <prefix><sanitized_username>_longeststreamstreak

Default prefix:

- streamstreak_

Username normalization:

- Lowercased
- Trimmed
- Non [a-z0-9_] characters replaced with _ for variable key safety

## Suggested Firebot Wiring

1. Add stream-backend.js to Startup Scripts (the only startup script needed).
2. Import session-controls.firebotsetup for !sessionnew / !sessionresume / !sessionend / !sessionstatus commands.
3. Import stream-streak.firebotsetup for !streak / !streakme / !streakmark commands and the viewer-arrived event.
4. For attendance updates in other contexts, use the `surtur:stream-streak-mark` effect.
5. For session control in other contexts, use the `surtur:stream-session-control` effect.
6. For streak display in chat, use `$streamStreak[$user, streamstreak]` style variables.
7. For session info in chat, use `$streamSession[id]` style variables.

## Tags
Firebot setups can not include tags. All commands and events in these modules are tagged with a specific ID.
To add that tag to your Firebot instance you'll need to add the necessary record to the sort-tags.json file.
You can name the tag whatever you want but the ID has to be the same. Below is an example for the
stream streak module.

{
    "commands": [
        ...
        {
            "id": "c14fd57e-f2d2-43af-aed8-e8c7fd146737",
            "name": "stream-streak"
        }
        ...
    ],
    "events": [
        ...
        {
            "id": "c14fd57e-f2d2-43af-aed8-e8c7fd146737",
            "name": "stream-streak"
        }
        ...
    ]
}

Below is a list of the id's and the modules they are connected to.
* 823c9b3b-7efc-4346-95e7-c1528631473d  -  session (base module)
* c14fd57e-f2d2-43af-aed8-e8c7fd146737  -  stream-streak

## Notes

- This documentation intentionally excludes pre-existing scripts in the scripts folder.
- The startup prompt uses Firebot's frontend modal bridge and falls back safely if no prompt response is available.
- Legacy scripts `stream-streak.js`, `stream-streak-helper.js`, `stream-session-startup.js`, `stream-session-control.js`, and `stream-streak-backend.js` have been retired and replaced by `stream-backend.js`.
