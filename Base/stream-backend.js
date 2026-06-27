"use strict";

/**
 * stream-backend.js — Unified Firebot startup backend
 *
 * Registers:
 *   - $streamStreak[username, field]  replace variable
 *   - surtur:stream-streak-mark       attendance-marking effect
 *   - surtur:stream-session-control   session lifecycle effect
 *
 * Also runs the startup session bootstrap on first load.
 */

const {
    bootstrapStreamSession,
    createSession,
    endActiveSession,
    ensureActiveSession,
    getActiveSession,
    getUserStreamStats,
    markViewerSeenForActiveStream,
    normalizeChoice,
    normalizeUsername,
    recordGameChange,
    updateStreamTitle,
    incrementFollowerCount,
    incrementSubCount,
    updateViewerMetadata,
    finalizeAllViewersForSession,
    getAllViewersForSession
} = require("./stream-session-store");

const GLOBAL_FLAG = "__streamBackendLoaded";

// ─── Username helpers ───────────────────────────────────────────────────────

function resolveTriggerUsername(trigger) {
    const candidates = [
        trigger?.metadata?.username,
        trigger?.metadata?.userName,
        trigger?.metadata?.displayName,
        trigger?.metadata?.user
    ];
    for (const v of candidates) {
        if (typeof v === "string" && v.trim().length > 0) {
            return v.trim();
        }
    }
    return null;
}

function resolveUsernameFromVariable(trigger, usernameArg) {
    const preferred = typeof usernameArg === "string" ? usernameArg.trim() : "";
    return normalizeUsername(preferred.length > 0 ? preferred : resolveTriggerUsername(trigger));
}

function resolveUsernameFromEffect(trigger, explicitUsername) {
    const preferred = typeof explicitUsername === "string" ? explicitUsername.trim() : "";
    return normalizeUsername(preferred.length > 0 ? preferred : resolveTriggerUsername(trigger));
}

// ─── $streamStreak variable ─────────────────────────────────────────────────

function getStreakFieldValue(stats, field) {
    switch (String(field ?? "streamstreak").trim().toLowerCase()) {
    case "username": case "user":           return stats.username ?? "";
    case "streamstreak": case "streak": case "current": return stats.streamstreak;
    case "totalstreams": case "total":      return stats.totalstreams;
    case "longeststreamstreak": case "longest": return stats.longeststreamstreak;
    case "json": case "raw":               return JSON.stringify(stats);
    default:                               return stats.streamstreak;
    }
}

function createStreamStreakVariable() {
    return {
        definition: {
            handle: "streamStreak",
            usage: "streamStreak[username, field]",
            description: "Read stream streak stats from the session framework.",
            examples: [
                { usage: "streamStreak[$user, streamstreak]",       description: "Current streak for the trigger user." },
                { usage: "streamStreak[$user, totalstreams]",        description: "Total attended streams." },
                { usage: "streamStreak[$user, longeststreamstreak]", description: "Longest streak ever." },
                { usage: "streamStreak[$user, username]",            description: "Normalized username used for lookup." },
                { usage: "streamStreak[$user, json]",                description: "All stats as a JSON string." }
            ],
            categories: ["advanced", "user based"],
            possibleDataOutput: ["number", "text"]
        },
        evaluator: (trigger, usernameArg, fieldArg) => {
            const username = resolveUsernameFromVariable(trigger, usernameArg);
            if (username == null) {
                return String(fieldArg ?? "").toLowerCase() === "username" ? "" : 0;
            }
            return getStreakFieldValue(getUserStreamStats(username), fieldArg);
        }
    };
}

// ─── $streamSession variable ────────────────────────────────────────────────

function createStreamSessionVariable() {
    return {
        definition: {
            handle: "streamSession",
            usage: "streamSession[field]",
            description: "Read the current active stream session info.",
            examples: [
                { usage: "streamSession[id]",        description: "Active stream ID, or empty if no session." },
                { usage: "streamSession[active]",    description: "\"true\" if a session is active, otherwise \"false\"." },
                { usage: "streamSession[startedAt]", description: "ISO timestamp the session started." }
            ],
            categories: ["advanced"],
            possibleDataOutput: ["text"]
        },
        evaluator: (_trigger, fieldArg) => {
            const session = getActiveSession();
            const key = String(fieldArg ?? "id").trim().toLowerCase();
            switch (key) {
            case "id":        return session?.streamId ?? "";
            case "active":    return session != null ? "true" : "false";
            case "startedat": return session?.startedAt ?? "";
            default:          return session?.streamId ?? "";
            }
        }
    };
}

// ─── Streak custom variable helpers ─────────────────────────────────────────

function sanitizeKey(username) {
    return username.replace(/[^a-z0-9_]/g, "_");
}

function writeStreakVariables(modules, username, stats, prefix) {
    const cvm = modules?.customVariableManager;
    if (cvm == null || typeof cvm.addCustomVariable !== "function") { return; }
    const p = typeof prefix === "string" && prefix.length > 0 ? prefix : "streamstreak_";
    const k = sanitizeKey(username);
    cvm.addCustomVariable(`${p}${k}_streamstreak`,        stats.streamstreak,        0, null, true);
    cvm.addCustomVariable(`${p}${k}_totalstreams`,         stats.totalstreams,         0, null, true);
    cvm.addCustomVariable(`${p}${k}_longeststreamstreak`,  stats.longeststreamstreak,  0, null, true);
    cvm.addCustomVariable(`${p}current_username`,          username,                   0, null, true);
    cvm.addCustomVariable(`${p}current_streamstreak`,      stats.streamstreak,         0, null, true);
    cvm.addCustomVariable(`${p}current_totalstreams`,      stats.totalstreams,         0, null, true);
    cvm.addCustomVariable(`${p}current_longeststreamstreak`, stats.longeststreamstreak, 0, null, true);
}

// ─── surtur:stream-streak-mark effect ───────────────────────────────────────

function createMarkAttendanceEffect() {
    return {
        definition: {
            id: "surtur:stream-streak-mark",
            name: "Stream Streak Mark Attendance",
            description: "Marks a viewer as attended for the active stream session and computes streak stats.",
            icon: "fad fa-user-check",
            categories: ["advanced", "scripting"],
            dependencies: [],
            outputs: [
                { defaultName: "username",               label: "Username",               description: "Normalized username that was marked." },
                { defaultName: "streamstreak",           label: "Current Stream Streak",  description: "Current consecutive stream streak." },
                { defaultName: "totalstreams",           label: "Total Streams",          description: "Total attended streams." },
                { defaultName: "longeststreamstreak",    label: "Longest Stream Streak",  description: "Longest consecutive stream streak." },
                { defaultName: "recordedForActiveStream", label: "Recorded",             description: "Whether attendance was recorded for an active session." }
            ]
        },
        optionsTemplate: `
            <eos-container header="Username (optional)">
                <p class="muted">Leave blank to use the triggering user.</p>
                <input type="text" class="form-control" ng-model="effect.username"
                    placeholder="$user" replace-variables menu-position="under" />
            </eos-container>
        `,
        getDefaultLabel: (effect) => effect?.username?.length ? effect.username : "Mark Trigger User",
        onTriggerEvent: async ({ effect, trigger }) => {
            const username = resolveUsernameFromEffect(trigger, effect?.username);
            if (username == null) {
                return { success: false, outputs: { username: "", streamstreak: 0, totalstreams: 0, longeststreamstreak: 0, recordedForActiveStream: false } };
            }

            const result = markViewerSeenForActiveStream(username);
            const stats  = result?.stats ?? getUserStreamStats(username);

            writeStreakVariables(global.__streamBackendModules, username, stats, "streamstreak_");

            // Capture additional metadata at arrival time
            const activeSession = getActiveSession();
            if (activeSession && result.recorded) {
                const twitchApi = global.__streamBackendModules?.twitchApi;
                const userDb = global.__streamBackendModules?.userDatabase;
                
                if (twitchApi && userDb) {
                    try {
                        const userInfo = userDb.getUserById(username);
                        const viewtimeMinutes = userInfo?.minutesWatched ?? 0;
                        const isSub = userInfo?.isSubscriber ?? false;
                        const isFollower = userInfo?.isFollower ?? false;
                        updateViewerMetadata(activeSession.streamId, username, isSub, isFollower, viewtimeMinutes);
                    } catch (e) {
                        // Silent fail on metadata capture
                    }
                }
            }

            return {
                success: true,
                outputs: {
                    username,
                    streamstreak:            stats.streamstreak,
                    totalstreams:            stats.totalstreams,
                    longeststreamstreak:     stats.longeststreamstreak,
                    recordedForActiveStream: !!result.recorded
                }
            };
        }
    };
}

// ─── surtur:stream-session-control effect ───────────────────────────────────

function createSessionControlEffect() {
    return {
        definition: {
            id: "surtur:stream-session-control",
            name: "Stream Session Control",
            description: "Start, resume, end, or inspect the active stream session.",
            icon: "fad fa-stream",
            categories: ["advanced", "scripting"],
            dependencies: [],
            outputs: [
                { defaultName: "sessionAction",    label: "Action Taken",    description: "new / resume / end / status" },
                { defaultName: "sessionId",        label: "Session ID",      description: "Active stream session ID." },
                { defaultName: "sessionStartedAt", label: "Started At",      description: "ISO timestamp the session started." },
                { defaultName: "sessionEndedAt",   label: "Ended At",        description: "ISO timestamp the session ended (if ended)." }
            ]
        },
        optionsTemplate: `
            <eos-container header="Action">
                <select class="form-control" ng-model="effect.action" aria-label="Session action">
                    <option value="status">Status (read current session)</option>
                    <option value="new">New (end current and start fresh)</option>
                    <option value="resume">Resume (create if none, keep if exists)</option>
                    <option value="end">End (close the active session)</option>
                </select>
            </eos-container>
            <eos-container header="Notes (optional)" pad-top="true">
                <input type="text" class="form-control" ng-model="effect.notes"
                    placeholder="Optional note attached to the session row"
                    replace-variables menu-position="under" />
            </eos-container>
        `,
        optionsController: ($scope) => {
            if ($scope.effect.action == null) { $scope.effect.action = "status"; }
        },
        getDefaultLabel: (effect) => {
            const labels = { new: "New Session", resume: "Resume Session", end: "End Session", status: "Session Status" };
            return labels[effect?.action] ?? "Session Control";
        },
        onTriggerEvent: async ({ effect }) => {
            const action = normalizeChoice(effect?.action ?? "status", getActiveSession());
            const notes  = typeof effect?.notes === "string" ? effect.notes.trim() : "";

            if (action === "end") {
                const activeSession = getActiveSession();
                
                // Finalize viewtimes for all viewers before ending session
                if (activeSession) {
                    const viewers = getAllViewersForSession(activeSession.streamId);
                    const userDb = global.__streamBackendModules?.userDatabase;
                    if (userDb && viewers.length > 0) {
                        const viewtimes = {};
                        for (const username of viewers) {
                            try {
                                const userInfo = userDb.getUserById(username);
                                viewtimes[username] = userInfo?.minutesWatched ?? 0;
                            } catch (e) {
                                // Silent fail on individual viewtime capture
                            }
                        }
                        finalizeAllViewersForSession(activeSession.streamId, viewtimes);
                    }
                }

                const s = endActiveSession({ notes: notes || "session control effect: end" });
                return { success: true, outputs: { sessionAction: "end",   sessionId: s?.streamId ?? "", sessionStartedAt: s?.startedAt ?? "", sessionEndedAt: s?.endedAt ?? "" } };
            }

            if (action === "new") {
                const active = getActiveSession();
                if (active) { endActiveSession({ notes: notes || "session control effect: superseded by new" }); }
                const s = createSession({ source: "effect", notes: notes || null });
                return { success: true, outputs: { sessionAction: "new",   sessionId: s.streamId, sessionStartedAt: s.startedAt, sessionEndedAt: "" } };
            }

            if (action === "resume") {
                const r = ensureActiveSession({ source: "effect", notes: notes || null });
                return { success: true, outputs: { sessionAction: r.created ? "new" : "resume", sessionId: r.session?.streamId ?? "", sessionStartedAt: r.session?.startedAt ?? "", sessionEndedAt: "" } };
            }

            // status
            const s = getActiveSession();
            return { success: true, outputs: { sessionAction: "status", sessionId: s?.streamId ?? "", sessionStartedAt: s?.startedAt ?? "", sessionEndedAt: s?.endedAt ?? "" } };
        }
    };
}

// ─── Event listeners ────────────────────────────────────────────────────────

function setupEventListeners(modules) {
    const backendCommunicator = modules?.backendCommunicator;
    if (backendCommunicator == null) { return; }

    // Listen for game changes on Twitch
    if (typeof backendCommunicator.on === "function") {
        backendCommunicator.on("twitch:game-changed", (data) => {
            const activeSession = getActiveSession();
            if (activeSession) {
                recordGameChange(activeSession.streamId, data?.gameName ?? null, data?.gameId ?? null);
            }
        });

        // Listen for follows
        backendCommunicator.on("twitch:follow", () => {
            const activeSession = getActiveSession();
            if (activeSession) {
                incrementFollowerCount(activeSession.streamId);
            }
        });

        // Listen for subs/resubs/gift-subs
        backendCommunicator.on("twitch:sub", () => {
            const activeSession = getActiveSession();
            if (activeSession) {
                incrementSubCount(activeSession.streamId);
            }
        });

        backendCommunicator.on("twitch:resub", () => {
            const activeSession = getActiveSession();
            if (activeSession) {
                incrementSubCount(activeSession.streamId);
            }
        });

        backendCommunicator.on("twitch:gift-sub", () => {
            const activeSession = getActiveSession();
            if (activeSession) {
                incrementSubCount(activeSession.streamId);
            }
        });
    }
}

// ─── Registration ────────────────────────────────────────────────────────────

function registerAll(modules) {
    const rvm = modules?.replaceVariableManager;
    const em  = modules?.effectManager;
    if (rvm == null || typeof rvm.registerReplaceVariable !== "function") { return false; }
    if (em  == null || typeof em.registerEffect !== "function")           { return false; }

    rvm.registerReplaceVariable(createStreamStreakVariable());
    rvm.registerReplaceVariable(createStreamSessionVariable());
    em.registerEffect(createMarkAttendanceEffect());
    em.registerEffect(createSessionControlEffect());
    return true;
}

// ─── Script manifest + run ───────────────────────────────────────────────────

exports.getScriptManifest = () => ({
    name: "Stream Backend",
    description: "Unified startup backend: session lifecycle, streak variables, and attendance effects.",
    author: "Surtur The Black",
    version: "0.1.0",
    startupOnly: true,
    firebotVersion: "5"
});

exports.run = async (runRequest) => {
    const logger = runRequest?.modules?.logger;

    if (global[GLOBAL_FLAG]) {
        return { success: true };
    }

    global.__streamBackendModules = runRequest?.modules;

    const registered = registerAll(runRequest?.modules);

    if (!registered) {
        if (logger?.warn) { logger.warn("Stream Backend: could not register variables/effects — managers unavailable."); }
        return { success: false, errorMessage: "replaceVariableManager or effectManager unavailable" };
    }

    // Set up event listeners for twitch events
    setupEventListeners(runRequest?.modules);

    // Run startup session bootstrap (prompts streamer for new/resume/end)
    try {
        const result = await bootstrapStreamSession(runRequest, logger, "startup");
        if (logger?.info) {
            logger.info(`Stream Backend loaded. Session action="${result.action}", id="${result.session?.streamId}".`);
        }

        // Capture stream title at session start
        if (result.session && runRequest?.modules?.twitchApi) {
            try {
                const channelInfo = runRequest.modules.twitchApi.getChannelInfo?.();
                if (channelInfo?.game) {
                    updateStreamTitle(result.session.streamId, channelInfo.game);
                }
            } catch (e) {
                // Silent fail on title capture
            }
        }
    } catch (err) {
        if (logger?.warn) { logger.warn("Stream Backend: session bootstrap error.", err?.message); }
    }

    global[GLOBAL_FLAG] = true;
    return { success: true };
};
