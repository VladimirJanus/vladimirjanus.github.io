// StatsManager.js - Local statistics tracking with localStorage persistence
// ============================================================================

import { GameVariant } from '../core/CoreEnums.js';

const STATS_KEY = 'minesweeper_online_stats';
const SOLO_TIME_ALIVE_MAX_SINGLE_RUN_MS = 12 * 60 * 60 * 1000;
const SOLO_TIME_ALIVE_REPAIR_MAX_AVERAGE_MS = 6 * 60 * 60 * 1000;
const SOLO_TIME_ALIVE_REPAIR_PER_GAME_MS = 60 * 1000;
const SOLO_TIME_ALIVE_REPAIR_DEADLINE_MS = new Date(2026, 5, 1).getTime();

const MODE_KEYS = ['solo', 'soloRated', 'coopHard', 'coopSoft', 'pvpDuel', 'community', 'pvp2Teams', 'pvpConquest'];
const VARIANT_KEYS = ['normal', 'Cuboid', 'FOW', 'infinite'];
const LEGACY_VARIANT_KEYS = ['normal', 'minesweeper_3d', 'fog_of_war', 'infinite_minesweeper'];

export const StatsMode = Object.freeze({
    Solo:       0,
    SoloRated:  1,
    CoOpHard:   2,
    CoOpSoft:   3,
    PVPDuel:    4,
    Community:  5,
    PVP2Teams:  6,
    PVPConquest: 7,
});

// Alias to the global GameVariant enum (kept for backwards compatibility with existing imports)
export const StatsVariant = GameVariant;

export function variantFromString(s) {
    if (s === 'Cuboid' || s === 'minesweeper_3d') return GameVariant.Cuboid;
    if (s === 'FOW' || s === 'fog_of_war') return GameVariant.FOW;
    if (s === 'infinite' || s === 'infinite_minesweeper') return GameVariant.infinite;
    return GameVariant.normal;
}

function emptyModeStats() {
    return { reveals: 0, flags: 0, minesClicked: 0, gridsCompleted: 0, timeAliveMs: 0, gamesPlayed: 0, duelsWon: 0, duelsLost: 0, gamesWon: 0 };
}

function sanitizedTimeAliveMs(mode, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    if (mode === StatsMode.Solo && ms > SOLO_TIME_ALIVE_MAX_SINGLE_RUN_MS) {
        console.warn('[StatsManager] Ignored implausible solo time-alive', ms, 'ms');
        return 0;
    }
    return ms;
}

export class StatsManager {
    constructor() {
        this._stats = MODE_KEYS.map(() => VARIANT_KEYS.map(() => emptyModeStats()));
        this._dirty = false;
        this._load();
        if (this._dirty) {
            this._flush();
        }
        // Periodic flush every 30 seconds
        this._flushInterval = setInterval(() => this._flush(), 30000);
        // Flush on unload
        window.addEventListener('beforeunload', () => this._flush());
    }

    // ── Fast in-memory increments ──

    addReveal(mode, count = 1, variant = StatsVariant.normal) {
        this._stats[mode][variant].reveals += count;
        this._dirty = true;
    }

    addFlag(mode, count = 1, variant = StatsVariant.normal) {
        this._stats[mode][variant].flags += count;
        this._dirty = true;
    }

    addMineClicked(mode, variant = StatsVariant.normal) {
        this._stats[mode][variant].minesClicked++;
        this._dirty = true;
    }

    addGridCompleted(mode, variant = StatsVariant.normal) {
        this._stats[mode][variant].gridsCompleted++;
        this._dirty = true;
    }

    addTimeAlive(mode, ms, variant = StatsVariant.normal) {
        const safeMs = sanitizedTimeAliveMs(mode, ms);
        if (safeMs <= 0) return;
        this._stats[mode][variant].timeAliveMs += safeMs;
        this._dirty = true;
    }

    addGamePlayed(mode, variant = StatsVariant.normal) {
        this._stats[mode][variant].gamesPlayed++;
        this._dirty = true;
    }

    addDuelWon(mode, variant = StatsVariant.normal) {
        this._stats[mode][variant].duelsWon++;
        this._dirty = true;
    }

    addDuelLost(mode, variant = StatsVariant.normal) {
        this._stats[mode][variant].duelsLost++;
        this._dirty = true;
    }

    addGameWon(mode, variant = StatsVariant.normal) {
        this._stats[mode][variant].gamesWon++;
        this._dirty = true;
    }

    // ── Read access for UI ──

    toJSON() {
        const result = {};
        const totals = emptyModeStats();
        const onlineTotals = emptyModeStats();
        const variants = {};
        for (let i = 0; i < MODE_KEYS.length; i++) {
            const agg = emptyModeStats();
            const modeVariants = {};
            for (let v = 0; v < VARIANT_KEYS.length; v++) {
                const s = this._stats[i][v];
                agg.reveals        += s.reveals;
                agg.flags          += s.flags;
                agg.minesClicked   += s.minesClicked;
                agg.gridsCompleted += s.gridsCompleted;
                agg.timeAliveMs    += s.timeAliveMs;
                agg.gamesPlayed    += s.gamesPlayed;
                agg.duelsWon       += s.duelsWon;
                agg.duelsLost      += s.duelsLost;
                agg.gamesWon       += s.gamesWon;
                modeVariants[VARIANT_KEYS[v]] = { ...s };
            }
            variants[MODE_KEYS[i]] = modeVariants;
            result[MODE_KEYS[i]] = agg;

            totals.reveals        += agg.reveals;
            totals.flags          += agg.flags;
            totals.minesClicked   += agg.minesClicked;
            totals.gridsCompleted += agg.gridsCompleted;
            totals.timeAliveMs    += agg.timeAliveMs;
            totals.gamesPlayed    += agg.gamesPlayed;
            totals.duelsWon       += agg.duelsWon;
            totals.duelsLost      += agg.duelsLost;
            totals.gamesWon       += agg.gamesWon;
            if (i !== StatsMode.Solo) {
                onlineTotals.reveals        += agg.reveals;
                onlineTotals.flags          += agg.flags;
                onlineTotals.minesClicked   += agg.minesClicked;
                onlineTotals.gridsCompleted += agg.gridsCompleted;
                onlineTotals.timeAliveMs    += agg.timeAliveMs;
                onlineTotals.gamesPlayed    += agg.gamesPlayed;
                onlineTotals.duelsWon       += agg.duelsWon;
                onlineTotals.duelsLost      += agg.duelsLost;
                onlineTotals.gamesWon       += agg.gamesWon;
            }
        }
        result.total = totals;
        result.onlineTotal = onlineTotals;
        result.variants = variants;
        return result;
    }

    // ── Persistence ──

    _load() {
        try {
            const stored = localStorage.getItem(STATS_KEY);
            if (!stored) return;
            const data = JSON.parse(stored);
            for (let i = 0; i < MODE_KEYS.length; i++) {
                const saved = data[MODE_KEYS[i]];
                if (!saved) continue;
                // Migration: old flat format has "reveals" directly
                if (typeof saved.reveals === 'number') {
                    const s = this._stats[i][StatsVariant.normal];
                    s.reveals        = saved.reveals        || 0;
                    s.flags          = saved.flags          || 0;
                    s.minesClicked   = saved.minesClicked   || 0;
                    s.gridsCompleted = saved.gridsCompleted || 0;
                    s.timeAliveMs    = saved.timeAliveMs    || 0;
                    s.gamesPlayed    = saved.gamesPlayed    || 0;
                    s.duelsWon       = saved.duelsWon       || 0;
                    s.duelsLost      = saved.duelsLost      || 0;
                    s.gamesWon       = saved.gamesWon       || 0;
                } else {
                    // New nested format
                    for (let v = 0; v < VARIANT_KEYS.length; v++) {
                        const vs = saved[VARIANT_KEYS[v]] || saved[LEGACY_VARIANT_KEYS[v]];
                        if (!vs) continue;
                        const s = this._stats[i][v];
                        s.reveals        = vs.reveals        || 0;
                        s.flags          = vs.flags          || 0;
                        s.minesClicked   = vs.minesClicked   || 0;
                        s.gridsCompleted = vs.gridsCompleted || 0;
                        s.timeAliveMs    = vs.timeAliveMs    || 0;
                        s.gamesPlayed    = vs.gamesPlayed    || 0;
                        s.duelsWon       = vs.duelsWon       || 0;
                        s.duelsLost      = vs.duelsLost      || 0;
                        s.gamesWon       = vs.gamesWon       || 0;
                    }
                }
            }

            if (Date.now() < SOLO_TIME_ALIVE_REPAIR_DEADLINE_MS) {
                for (const soloStats of this._stats[StatsMode.Solo]) {
                    const gamesPlayed = Math.max(1, soloStats.gamesPlayed || 0);
                    const maxExpectedTimeAliveMs = gamesPlayed * SOLO_TIME_ALIVE_REPAIR_MAX_AVERAGE_MS;
                    if (soloStats.timeAliveMs > maxExpectedTimeAliveMs) {
                        const repairedTimeAliveMs = (soloStats.gamesPlayed || 0) * SOLO_TIME_ALIVE_REPAIR_PER_GAME_MS;
                        if (soloStats.timeAliveMs !== repairedTimeAliveMs) {
                            soloStats.timeAliveMs = repairedTimeAliveMs;
                            this._dirty = true;
                        }
                    }
                }
            }
        } catch (_) { /* ignore corrupt data */ }
    }

    _flush() {
        if (!this._dirty) return;
        this._dirty = false;
        try {
            const data = {};
            for (let i = 0; i < MODE_KEYS.length; i++) {
                const modeObj = {};
                for (let v = 0; v < VARIANT_KEYS.length; v++) {
                    modeObj[VARIANT_KEYS[v]] = { ...this._stats[i][v] };
                }
                data[MODE_KEYS[i]] = modeObj;
            }
            localStorage.setItem(STATS_KEY, JSON.stringify(data));
        } catch (_) { /* storage full */ }
    }
}
