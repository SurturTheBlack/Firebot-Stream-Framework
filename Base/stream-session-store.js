"use strict";

const path = require("path");
const { randomUUID } = require("crypto");

const { DatabaseSync } = require("node:sqlite");

let database;

function getProfileRoot() {
    return path.resolve(__dirname, "..");
}

function getDatabasePath() {
    return path.join(getProfileRoot(), "db", "stream-db.sqlite");
}

function getDatabase() {
    if (database != null) {
        return database;
    }

    const dbPath = getDatabasePath();
    database = new DatabaseSync(dbPath);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(`
        CREATE TABLE IF NOT EXISTS stream_sessions (
            id TEXT PRIMARY KEY,
            stream_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            source TEXT,
            notes TEXT,
            title TEXT,
            new_followers_count INTEGER DEFAULT 0,
            new_subs_count INTEGER DEFAULT 0
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_sessions_stream_id
            ON stream_sessions(stream_id);

        CREATE INDEX IF NOT EXISTS idx_stream_sessions_active
            ON stream_sessions(ended_at, started_at);

        CREATE TABLE IF NOT EXISTS stream_viewers (
            stream_id TEXT NOT NULL,
            username TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            viewtime_minutes_at_arrival INTEGER,
            viewtime_minutes_at_end INTEGER,
            was_subscriber BOOLEAN DEFAULT 0,
            was_follower BOOLEAN DEFAULT 0,
            PRIMARY KEY (stream_id, username),
            FOREIGN KEY (stream_id) REFERENCES stream_sessions(stream_id)
        );

        CREATE INDEX IF NOT EXISTS idx_stream_viewers_username
            ON stream_viewers(username);

        CREATE TABLE IF NOT EXISTS stream_games (
            id TEXT PRIMARY KEY,
            stream_id TEXT NOT NULL,
            game_name TEXT,
            game_id TEXT,
            started_at TEXT NOT NULL,
            FOREIGN KEY (stream_id) REFERENCES stream_sessions(stream_id)
        );

        CREATE INDEX IF NOT EXISTS idx_stream_games_stream_id
            ON stream_games(stream_id);
    `);

    return database;
}

function normalizeUsername(username) {
    if (typeof username !== "string") {
        return null;
    }

    const normalized = username.trim().toLowerCase();
    if (normalized.length < 1) {
        return null;
    }

    return normalized;
}

function nowIso() {
    return new Date().toISOString();
}

function generateStreamId() {
    return `stream-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function rowToSession(row) {
    if (row == null) {
        return null;
    }

    return {
        id: row.id,
        streamId: row.stream_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        source: row.source,
        notes: row.notes
    };
}

function getSessionById(id) {
    const db = getDatabase();
    const row = db.prepare(`
        SELECT id, stream_id, started_at, ended_at, source, notes
        FROM stream_sessions
        WHERE id = ?
        LIMIT 1
    `).get(id);

    return rowToSession(row);
}

function getActiveSession() {
    const db = getDatabase();
    const row = db.prepare(`
        SELECT id, stream_id, started_at, ended_at, source, notes
        FROM stream_sessions
        WHERE ended_at IS NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1
    `).get();

    return rowToSession(row);
}

function createSession({ streamId, startedAt = nowIso(), source = null, notes = null } = {}) {
    const db = getDatabase();
    const sessionId = randomUUID();
    const finalStreamId = streamId ?? generateStreamId();

    db.prepare(`
        INSERT INTO stream_sessions (id, stream_id, started_at, ended_at, source, notes)
        VALUES (@id, @streamId, @startedAt, NULL, @source, @notes)
    `).run({
        id: sessionId,
        streamId: finalStreamId,
        startedAt,
        source,
        notes
    });

    return getSessionById(sessionId);
}

function endActiveSession({ endedAt = nowIso(), notes = null } = {}) {
    const db = getDatabase();
    const activeSession = getActiveSession();

    if (activeSession == null) {
        return null;
    }

    db.prepare(`
        UPDATE stream_sessions
        SET ended_at = COALESCE(ended_at, @endedAt),
            notes = CASE
                WHEN @notes IS NULL OR @notes = '' THEN notes
                ELSE @notes
            END
        WHERE id = @id
    `).run({
        id: activeSession.id,
        endedAt,
        notes
    });

    return getSessionById(activeSession.id);
}

function ensureActiveSession({ source = null, notes = null } = {}) {
    const activeSession = getActiveSession();

    if (activeSession != null) {
        return {
            session: activeSession,
            created: false
        };
    }

    return {
        session: createSession({ source, notes }),
        created: true
    };
}

async function openStreamChoicePrompt(frontendCommunicator, activeSession) {
    if (frontendCommunicator == null || typeof frontendCommunicator.fireEventAsync !== "function") {
        return null;
    }

    const hasSession = activeSession != null;

    // inputType:"hidden" renders the <input> as type=hidden so it is invisible.
    // The modal becomes a pure message + two buttons:
    //   Save button  (labelled below) → resolves with model value
    //   Cancel button (always "Cancel") → resolves with null
    //
    // When a session EXISTS:
    //   "New Stream" (Save) → "new"   — requires explicit click to destroy session
    //   "Cancel"            → "resume" — safe default, keeps the session
    //
    // When NO session exists:
    //   "Start Stream" (Save) → "new"
    //   "Cancel"              → "new"  (no session to resume anyway)

    const request = {
        config: {
            model: "new",
            inputType: "hidden",
            label: "Stream Session",
            descriptionText: hasSession
                ? `Stream session in progress.\n\nClick New Stream to end the current session and start a fresh one, or click Cancel to resume the existing session.`
                : "No active stream session found.\n\nClick Start Stream to begin a new session.",
            saveText: hasSession ? "New Stream" : "Start Stream",
            validationText: ""
        },
        validation: {
            required: false
        }
    };

    try {
        const result = await Promise.race([
            frontendCommunicator.fireEventAsync("openGetInputModal", request),
            // Timeout defaults to safe behaviour
            new Promise((resolve) => setTimeout(() => resolve(null), 120000))
        ]);

        if (result == null) {
            // User cancelled or timed out — safe default
            return hasSession ? "resume" : "new";
        }

        return "new";
    } catch (error) {
        return hasSession ? "resume" : "new";
    }
}

async function promptForNewStream(runRequest, activeSession) {
    const frontendCommunicator = runRequest?.modules?.frontendCommunicator;

    if (frontendCommunicator == null) {
        // No bridge available — default to resume if session exists, otherwise new
        return activeSession == null ? "new" : "resume";
    }

    return openStreamChoicePrompt(frontendCommunicator, activeSession);
}

function listOrderedStreamIds() {
    const db = getDatabase();
    const rows = db.prepare(`
        SELECT stream_id
        FROM stream_sessions
        ORDER BY started_at ASC, id ASC
    `).all();

    return rows.map((row) => row.stream_id);
}

function getViewedStreamIdsForUser(username) {
    const normalizedUsername = normalizeUsername(username);
    if (normalizedUsername == null) {
        return new Set();
    }

    const db = getDatabase();
    const rows = db.prepare(`
        SELECT stream_id
        FROM stream_viewers
        WHERE username = ?
    `).all(normalizedUsername);

    return new Set(rows.map((row) => row.stream_id));
}

function getUserStreamStats(username) {
    const normalizedUsername = normalizeUsername(username);

    if (normalizedUsername == null) {
        return {
            username: null,
            streamstreak: 0,
            totalstreams: 0,
            longeststreamstreak: 0
        };
    }

    const orderedStreamIds = listOrderedStreamIds();
    const viewedStreamIds = getViewedStreamIdsForUser(normalizedUsername);

    let totalStreams = 0;
    let longestStreamStreak = 0;
    let runningStreak = 0;

    for (const streamId of orderedStreamIds) {
        if (viewedStreamIds.has(streamId)) {
            totalStreams += 1;
            runningStreak += 1;
            if (runningStreak > longestStreamStreak) {
                longestStreamStreak = runningStreak;
            }
        } else {
            runningStreak = 0;
        }
    }

    let currentStreamStreak = 0;
    for (let i = orderedStreamIds.length - 1; i >= 0; i -= 1) {
        if (viewedStreamIds.has(orderedStreamIds[i])) {
            currentStreamStreak += 1;
        } else {
            break;
        }
    }

    return {
        username: normalizedUsername,
        streamstreak: currentStreamStreak,
        totalstreams: totalStreams,
        longeststreamstreak: longestStreamStreak
    };
}

function markViewerSeen(streamId, username, seenAt = nowIso()) {
    const normalizedUsername = normalizeUsername(username);

    if (streamId == null || normalizedUsername == null) {
        return false;
    }

    const db = getDatabase();
    db.prepare(`
        INSERT OR IGNORE INTO stream_viewers (stream_id, username, first_seen_at)
        VALUES (?, ?, ?)
    `).run(streamId, normalizedUsername, seenAt);

    return true;
}

function markViewerSeenForActiveStream(username, seenAt = nowIso()) {
    const activeSession = getActiveSession();
    const normalizedUsername = normalizeUsername(username);

    if (activeSession == null || normalizedUsername == null) {
        return {
            recorded: false,
            activeSession,
            stats: getUserStreamStats(username)
        };
    }

    markViewerSeen(activeSession.streamId, normalizedUsername, seenAt);

    return {
        recorded: true,
        activeSession,
        stats: getUserStreamStats(normalizedUsername)
    };
}

function normalizeChoice(choice, activeSession) {
    if (choice == null) {
        return activeSession == null ? "new" : "resume";
    }

    if (typeof choice === "string") {
        const normalized = choice.trim().toLowerCase();
        if (["new", "resume", "end"].includes(normalized)) {
            return normalized;
        }
    }

    if (typeof choice === "object") {
        if (choice.choice != null) {
            return normalizeChoice(choice.choice, activeSession);
        }

        if (choice.isNewStream === true || choice.newStream === true) {
            return "new";
        }

        if (choice.isNewStream === false || choice.newStream === false) {
            return "resume";
        }
    }

    return activeSession == null ? "new" : "resume";
}

async function bootstrapStreamSession(runRequest, logger, source = "startup") {
    const activeSession = getActiveSession();
    const promptedChoice = await promptForNewStream(runRequest, activeSession);
    const choice = normalizeChoice(promptedChoice, activeSession);

    if (choice === "end") {
        const endedSession = endActiveSession({ notes: `${source}: ended before session start` });
        return {
            session: endedSession,
            action: "end"
        };
    }

    if (choice === "resume" && activeSession != null) {
        return {
            session: activeSession,
            action: "resume"
        };
    }

    if (activeSession != null) {
        endActiveSession({ notes: `${source}: superseded by new session` });
    }

    const session = createSession({
        source,
        notes: promptedChoice == null ? "auto-created because no prompt bridge was available" : null
    });

    if (logger != null && typeof logger.info === "function") {
        logger.info(`Stream session started: ${session.streamId}`);
    }

    return {
        session,
        action: "new"
    };
}

function recordGameChange(streamId, gameName, gameId) {
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(`
        INSERT INTO stream_games (id, stream_id, game_name, game_id, started_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, streamId, gameName, gameId, nowIso());
}

function updateStreamTitle(streamId, title) {
    const db = getDatabase();
    db.prepare(`
        UPDATE stream_sessions
        SET title = ?
        WHERE stream_id = ?
    `).run(title, streamId);
}

function incrementFollowerCount(streamId) {
    const db = getDatabase();
    db.prepare(`
        UPDATE stream_sessions
        SET new_followers_count = new_followers_count + 1
        WHERE stream_id = ?
    `).run(streamId);
}

function incrementSubCount(streamId) {
    const db = getDatabase();
    db.prepare(`
        UPDATE stream_sessions
        SET new_subs_count = new_subs_count + 1
        WHERE stream_id = ?
    `).run(streamId);
}

function updateViewerMetadata(streamId, username, wasSubscriber, wasFollower, viewtimeMinutesAtArrival) {
    const normalizedUsername = normalizeUsername(username);
    if (streamId == null || normalizedUsername == null) {
        return false;
    }

    const db = getDatabase();
    db.prepare(`
        UPDATE stream_viewers
        SET was_subscriber = ?,
            was_follower = ?,
            viewtime_minutes_at_arrival = ?
        WHERE stream_id = ? AND username = ?
    `).run(wasSubscriber ? 1 : 0, wasFollower ? 1 : 0, viewtimeMinutesAtArrival ?? null, streamId, normalizedUsername);
    return true;
}

function finalizeViewerViewtime(streamId, username, viewtimeMinutesAtEnd) {
    const normalizedUsername = normalizeUsername(username);
    if (streamId == null || normalizedUsername == null) {
        return false;
    }

    const db = getDatabase();
    db.prepare(`
        UPDATE stream_viewers
        SET viewtime_minutes_at_end = ?
        WHERE stream_id = ? AND username = ?
    `).run(viewtimeMinutesAtEnd ?? null, streamId, normalizedUsername);
    return true;
}

function finalizeAllViewersForSession(streamId, viewtimesByUsername) {
    const db = getDatabase();
    const stmt = db.prepare(`
        UPDATE stream_viewers
        SET viewtime_minutes_at_end = ?
        WHERE stream_id = ? AND username = ?
    `);

    for (const [username, minutes] of Object.entries(viewtimesByUsername || {})) {
        const normalized = normalizeUsername(username);
        if (normalized) {
            stmt.run(minutes, streamId, normalized);
        }
    }
}

function getAllViewersForSession(streamId) {
    const db = getDatabase();
    return db.prepare(`
        SELECT username FROM stream_viewers WHERE stream_id = ?
    `).all(streamId).map(row => row.username);
}

module.exports = {
    bootstrapStreamSession,
    createSession,
    endActiveSession,
    ensureActiveSession,
    generateStreamId,
    getActiveSession,
    getDatabasePath,
    getUserStreamStats,
    markViewerSeen,
    markViewerSeenForActiveStream,
    normalizeUsername,
    getSessionById,
    normalizeChoice,
    recordGameChange,
    updateStreamTitle,
    incrementFollowerCount,
    incrementSubCount,
    updateViewerMetadata,
    finalizeViewerViewtime,
    finalizeAllViewersForSession,
    getAllViewersForSession
};