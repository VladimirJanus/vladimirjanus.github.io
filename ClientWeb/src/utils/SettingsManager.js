// SettingsManager.js - Persistent settings via localStorage
// ============================================================================

import { LEVEL_PRESETS, OTHER_GAME_MODES } from '../core/CoreData.js';

const SETTINGS_STORAGE_KEY = 'settings.json';
const SESSION_KEY_STORAGE_KEY = 'network/sessionKey';
const COOLDOWNS_STORAGE_KEY = 'cooldowns.dat';

const DEFAULT_SETTINGS = Object.freeze({
    'player/nickname': 'Player',
    'audio/flagVolume': 0.1,
    'audio/revealVolume': 0.1,
    'visual/showActionDecals': true,
    'visual/digitalNumbers': false,
    'visual/digitalTextures': false,
    'visual/chatNotifications': true,
    'clickBehaviour/leftClick': 2,
    'clickBehaviour/rightClick': 1,
    'clickBehaviour/longLeftClick': 1,
    'solo/gridWidth': 20,
    'solo/gridHeight': 20,
    'solo/mineDensity': 20,
    'online/gridWidth': 20,
    'online/gridHeight': 20,
    'online/mineDensity': 20,
    'online/gameType': 0,
    'online/lobbyVisibility': 0,
    'lobby/autoApprovePending': false,
    'cachedServerIp': '',
    'cachedServerPort': 8080,
});

const SETTINGS_KEY_ALIASES = Object.freeze({
    playerName: 'player/nickname',
    flagVolume: 'audio/flagVolume',
    revealVolume: 'audio/revealVolume',
    showDecals: 'visual/showActionDecals',
    digitalNumbers: 'visual/digitalNumbers',
    digitalTextures: 'visual/digitalTextures',
    chatNotifications: 'visual/chatNotifications',
    clickBehaviourLeft: 'clickBehaviour/leftClick',
    clickBehaviourRight: 'clickBehaviour/rightClick',
    clickBehaviourLong: 'clickBehaviour/longLeftClick',
    gridWidth: 'solo/gridWidth',
    gridHeight: 'solo/gridHeight',
    mineDensity: 'solo/mineDensity',
    gameType: 'online/gameType',
    lobbyVisibility: 'online/lobbyVisibility',
    autoApprovePending: 'lobby/autoApprovePending',
});

function gameSaveStorageKeyForVariant(variant) {
    if (!variant || variant === 'normal') return 'gamesave.dat';
    if (variant === 'minesweeper_3d') return 'gamesave_minesweeper3d.dat';
    return `gamesave_${variant}.dat`;
}

function progressStorageKeyForVariant(variant) {
    if (!variant || variant === 'normal') return 'progress_normal.dat';
    if (variant === 'minesweeper_3d') return 'progress_minesweeper3d.dat';
    return `progress_${variant}.dat`;
}

const INFINITE_PRESET_DENSITIES = Object.freeze([18, 20, 40]);
const INFINITE_CHUNK_SIZE = 32;
const INFINITE_CHUNK_CELLS = INFINITE_CHUNK_SIZE * INFINITE_CHUNK_SIZE;

function encodeByteArrayToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i] & 0xFF);
    }
    return btoa(binary);
}

function decodeBase64ToByteArray(base64) {
    try {
        const binary = atob(base64);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            arr[i] = binary.charCodeAt(i) & 0xFF;
        }
        return arr;
    } catch {
        return null;
    }
}

export class SettingsManager {
    constructor() {
        this.settings = { ...DEFAULT_SETTINGS };
        this._respawnCooldowns = {};
        this._isCustomGame = false;
        this._loadSettings();
        this._loadCooldowns();
        this._loadGameSaves();
        this._cleanupOrphanedSaves();
    }

    get(key) {
        if (key === 'serverAddress') {
            return `${this.settings['cachedServerIp']}:${this.settings['cachedServerPort']}`;
        }
        return this.settings[this._resolveSettingKey(key)];
    }

    set(key, value) {
        if (key === 'serverAddress' && typeof value === 'string') {
            const parsed = this._parseServerAddress(value);
            if (parsed) {
                this.settings['cachedServerIp'] = parsed.ip;
                this.settings['cachedServerPort'] = parsed.port;
                this._saveSettings();
            }
            return;
        }
        this.settings[this._resolveSettingKey(key)] = value;
        this._saveSettings();
    }

    getAll() {
        return { ...this.settings };
    }

    _resolveSettingKey(key) {
        return SETTINGS_KEY_ALIASES[key] || key;
    }

    _parseServerAddress(address) {
        const raw = String(address || '').trim();
        if (!raw) return null;

        // Accept host:port and ws(s)://host:port
        const stripped = raw.replace(/^wss?:\/\//i, '');
        const lastColon = stripped.lastIndexOf(':');
        if (lastColon <= 0 || lastColon === stripped.length - 1) return null;

        const ip = stripped.slice(0, lastColon).trim();
        const port = parseInt(stripped.slice(lastColon + 1), 10);
        if (!ip || !Number.isFinite(port) || port <= 0 || port > 65535) return null;

        return { ip, port };
    }

    _loadSettings() {
        try {
            const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                this.settings = { ...DEFAULT_SETTINGS, ...parsed };
            }
        } catch (e) {
            // console.warn('[SettingsManager] Failed to load settings:', e);
        }
    }

    _saveSettings() {
        try {
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.settings));
        } catch (e) {
            // console.warn('[SettingsManager] Failed to save settings:', e);
        }
    }

    getSessionKey() {
        const b64 = localStorage.getItem(SESSION_KEY_STORAGE_KEY);
        if (!b64) return null;
        try {
            const binary = atob(b64);
            const arr = new Uint8Array(16);
            for (let i = 0; i < 16 && i < binary.length; i++) {
                arr[i] = binary.charCodeAt(i);
            }
            return arr;
        } catch (e) {
            return null;
        }
    }

    setSessionKey(uint8arr) {
        if (!uint8arr) {
            localStorage.removeItem(SESSION_KEY_STORAGE_KEY);
        } else {
            let binary = '';
            for (let i = 0; i < 16; i++) binary += String.fromCharCode(uint8arr[i]);
            localStorage.setItem(SESSION_KEY_STORAGE_KEY, btoa(binary));
        }
    }

    // ========================================================================
    // Rejoin Death Cooldowns
    // ========================================================================

    saveRespawnCooldown(gameID, expiryTimeMs) {
        this._respawnCooldowns[String(gameID)] = expiryTimeMs;
        this._saveCooldowns();
    }

    getRespawnCooldown(gameID) {
        return this._respawnCooldowns[String(gameID)] || 0;
    }

    cleanupExpiredCooldowns() {
        const now = Date.now();
        let changed = false;
        for (const gameID in this._respawnCooldowns) {
            if (now >= this._respawnCooldowns[gameID]) {
                delete this._respawnCooldowns[gameID];
                changed = true;
            }
        }
        if (changed) this._saveCooldowns();
    }

    _loadCooldowns() {
        try {
            const raw = localStorage.getItem(COOLDOWNS_STORAGE_KEY);
            if (!raw) {
                this._respawnCooldowns = {};
                return;
            }
            const parsed = JSON.parse(raw);
            this._respawnCooldowns = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            this._respawnCooldowns = {};
        }
    }

    _saveCooldowns() {
        try {
            localStorage.setItem(COOLDOWNS_STORAGE_KEY, JSON.stringify(this._respawnCooldowns));
        } catch {}
    }

    // ========================================================================
    // Grid data key helpers (mirrors Qt SettingsManager)
    // ========================================================================

    _findGameModeLevel(gameModeId, gridData) {
        const mode = OTHER_GAME_MODES.find(m => m.id === gameModeId);
        if (!mode) return null;
        for (const cat of mode.categories) {
            for (const lv of cat.levels) {
                if (gameModeId === 'infinite_minesweeper') {
                    if (Number(lv.density) === Number(gridData.density)) return lv;
                    continue;
                }
                if (lv.w === gridData.w && lv.h === gridData.h && lv.density === gridData.density
                    && (lv.l || 0) === (gridData.l || 0)) {
                    return lv;
                }
            }
        }
        return null;
    }

    gridDataKey(gridData, gameModeId = null) {
        if (gameModeId === 'infinite_minesweeper') {
            return `d${gridData.density}`;
        }
        if (gameModeId === 'fog_of_war') {
            const level = this._findGameModeLevel(gameModeId, gridData);
            if (level && Number.isFinite(level.visibleCells)) {
                return `${gridData.w}x${gridData.h}x${gridData.density}x${level.visibleCells}`;
            }
        } else if (gameModeId === 'minesweeper_3d') {
            const level = this._findGameModeLevel(gameModeId, gridData);
            if (level && Number.isFinite(level.l)) {
                return `${gridData.w}x${gridData.h}x${gridData.density}x${level.l}`;
            }
        }
        return `${gridData.w}x${gridData.h}x${gridData.density}`;
    }

    isKnownLevelPreset(gridData) {
        for (const cat of LEVEL_PRESETS) {
            for (const lv of cat.levels) {
                if (lv.w === gridData.w && lv.h === gridData.h && lv.density === gridData.density)
                    return true;
            }
        }
        return false;
    }

    isKnownGameModePreset(gameModeId, gridData) {
        return !!this._findGameModeLevel(gameModeId, gridData);
    }

    getGameModeLevelCategory(gameModeId, gridData) {
        const mode = OTHER_GAME_MODES.find(m => m.id === gameModeId);
        if (!mode) return null;
        for (const cat of mode.categories) {
            for (const lv of cat.levels) {
                if (gameModeId === 'infinite_minesweeper') {
                    if (Number(lv.density) === Number(gridData.density)) return cat.name;
                    continue;
                }
                if (lv.w === gridData.w && lv.h === gridData.h && lv.density === gridData.density
                    && (lv.l || 0) === (gridData.l || 0)) {
                    return cat.name;
                }
            }
        }
        return null;
    }

    getGameModeLevelShortName(gameModeId, gridData) {
        const mode = OTHER_GAME_MODES.find(m => m.id === gameModeId);
        if (!mode) return null;
        for (const cat of mode.categories) {
            for (const lv of cat.levels) {
                if (gameModeId === 'infinite_minesweeper') {
                    if (Number(lv.density) === Number(gridData.density)) return lv.name;
                    continue;
                }
                if (lv.w === gridData.w && lv.h === gridData.h && lv.density === gridData.density
                    && (lv.l || 0) === (gridData.l || 0)) {
                    return lv.name;
                }
            }
        }
        return null;
    }

    getGameModeLevelName(gameModeId, gridData) {
        const category = this.getGameModeLevelCategory(gameModeId, gridData);
        const level = this.getGameModeLevelShortName(gameModeId, gridData);
        if (!category || !level) return null;
        return `${category}: ${level}`;
    }

    getLevelCategory(gridData) {
        for (const cat of LEVEL_PRESETS) {
            for (const lv of cat.levels) {
                if (lv.w === gridData.w && lv.h === gridData.h && lv.density === gridData.density) {
                    return cat.name;
                }
            }
        }
        return null;
    }

    getLevelShortName(gridData) {
        for (const cat of LEVEL_PRESETS) {
            for (const lv of cat.levels) {
                if (lv.w === gridData.w && lv.h === gridData.h && lv.density === gridData.density) {
                    return lv.name;
                }
            }
        }
        return null;
    }

    getLevelName(gridData) {
        const category = this.getLevelCategory(gridData);
        const level = this.getLevelShortName(gridData);
        if (!category || !level) return null;
        return `${category}: ${level}`;
    }

    // ========================================================================
    // Game state persistence — multi-save keyed by level
    // ========================================================================

    /** Resolve save key: gridDataKey for known presets, "custom" otherwise. */
    resolveGameSaveKey(gridData) {
        return this.isKnownLevelPreset(gridData) ? this.gridDataKey(gridData) : 'custom';
    }

    /**
     * Resolve the key that the ACTIVE game should use for saves.
     * Custom games always go to "custom" regardless of dimensions.
     */
    resolveActiveSaveKey(gridData) {
        return this._isCustomGame ? 'custom' : this.resolveGameSaveKey(gridData);
    }

    /** Mark the current game as custom (true) or preset (false). */
    setCustomGame(isCustom) {
        this._isCustomGame = !!isCustom;
    }

    _loadGameSaves() {
        try {
            const raw = localStorage.getItem(gameSaveStorageKeyForVariant('normal'));
            if (!raw) { this._gameSaves = {}; this._lastGameKey = ''; return; }
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 2) { this._gameSaves = {}; this._lastGameKey = ''; return; }
            this._gameSaves = parsed.saves || {};
            this._lastGameKey = parsed.lastGameKey || '';
        } catch {
            this._gameSaves = {};
            this._lastGameKey = '';
        }
    }

    _saveGameSaves() {
        try {
            localStorage.setItem(gameSaveStorageKeyForVariant('normal'), JSON.stringify({
                version: 2,
                lastGameKey: this._lastGameKey,
                saves: this._gameSaves,
            }));
        } catch {}
    }

    _cleanupOrphanedSaves() {
        let changed = false;
        for (const key of Object.keys(this._gameSaves)) {
            if (key === 'custom') continue;
            const parts = key.split('x');
            if (parts.length !== 3) { delete this._gameSaves[key]; changed = true; continue; }
            const gd = { w: parseInt(parts[0]), h: parseInt(parts[1]), density: parseInt(parts[2]) };
            if (!this.isKnownLevelPreset(gd)) {
                delete this._gameSaves[key];
                changed = true;
            }
        }
        if (changed) {
            if (this._lastGameKey && !this._gameSaves[this._lastGameKey]) this._lastGameKey = '';
            this._saveGameSaves();
        }
    }

    _buildSaveEntry(grid, gridData, elapsedTimeMs, fogCache = [], fogCacheLimit = 20) {
        const cells = [];
        for (let y = 0; y < gridData.h; y++) {
            for (let x = 0; x < gridData.w; x++) {
                const c = grid[y][x];
                cells.push({ hasMine: c.content === 2, state: c.state });
            }
        }
        const entry = {
            w: gridData.w,
            h: gridData.h,
            density: gridData.density,
            elapsedTimeMs,
            cells,
        };
        if (this._isCustomGame) {
            entry.isCustom = true;
        }
        if (fogCache && fogCache.length > 0) {
            entry.fogCache = fogCache.map(p => ({ x: p.x, y: p.y }));
        }
        if (fogCacheLimit !== 20) {
            entry.fogCacheLimit = fogCacheLimit;
        }
        return entry;
    }

    _loadSaveEntry(entry) {
        if (!entry || !entry.w || !entry.h) return null;
        const w = entry.w, h = entry.h;
        if (!entry.cells || entry.cells.length !== w * h) return null;
        const grid = [];
        let idx = 0;
        for (let y = 0; y < h; y++) {
            grid[y] = [];
            for (let x = 0; x < w; x++) {
                const c = entry.cells[idx++];
                grid[y][x] = { content: c.hasMine ? 2 : 1, state: c.state };
            }
        }
        return {
            grid,
            gridData: { w, h, density: entry.density },
            elapsedTimeMs: entry.elapsedTimeMs || 0,
            fogCache: (entry.fogCache || []).map(o => ({ x: o.x, y: o.y })),
            fogCacheLimit: entry.fogCacheLimit || 20,
            isCustom: entry.isCustom || false,
        };
    }

    _isEntryResumable(entry) {
        if (!entry || !entry.cells || !entry.w || !entry.h) return false;

        let hasHiddenSafe = false;
        let hasRevealedMine = false;

        for (const c of entry.cells) {
            const isMine = !!c.hasMine;
            const state = c.state;
            const isRevealed = state === 1; // CellState.Revealed
            const isHidden = state === 0;   // CellState.Hidden

            if (!isMine && isHidden) hasHiddenSafe = true;
            if (isMine && isRevealed) {
                hasRevealedMine = true;
                break;
            }
        }

        // Resumable only when game is not finished: at least one hidden safe remains
        // and no mine has been revealed.
        return hasHiddenSafe && !hasRevealedMine;
    }

    _ensureResumableOrDrop(key) {
        const entry = this._gameSaves[key];
        if (!entry) return false;
        if (this._isEntryResumable(entry)) return true;

        delete this._gameSaves[key];
        if (this._lastGameKey === key) this._lastGameKey = '';
        this._saveGameSaves();
        return false;
    }

    _buildSaveInfo(entry) {
        if (!entry || !entry.w || !entry.h) return { exists: false };
        let mineCount = 0;
        for (const c of entry.cells) { if (c.hasMine) mineCount++; }
        const gridData = { w: entry.w, h: entry.h, density: entry.density };
        // If the save was made from a custom game, always label it 'Custom'
        // even when the dimensions happen to match a known preset.
        const levelName = entry.isCustom ? 'Custom' : this.getLevelName(gridData);
        return {
            exists: true,
            w: entry.w,
            h: entry.h,
            density: entry.density,
            mineCount,
            elapsedTimeMs: entry.elapsedTimeMs || 0,
            levelName,
        };
    }

    // ── Public API ──

    saveGameState(grid, gridData, elapsedTimeMs, fogCache = [], fogCacheLimit = 20) {
        if (!grid || grid.length === 0) return;
        const key = this.resolveActiveSaveKey(gridData);
        this._gameSaves[key] = this._buildSaveEntry(grid, gridData, elapsedTimeMs, fogCache, fogCacheLimit);
        this._lastGameKey = key;
        this._saveGameSaves();
    }

    loadGameState() {
        // Legacy compat: loads the last game
        return this.loadLastGameState();
    }

    loadLastGameState() {
        if (!this._lastGameKey || !this._gameSaves[this._lastGameKey]) return null;
        if (!this._ensureResumableOrDrop(this._lastGameKey)) return null;
        return this._loadSaveEntry(this._gameSaves[this._lastGameKey]);
    }

    loadGameStateForKey(key) {
        if (!this._gameSaves[key]) return null;
        if (!this._ensureResumableOrDrop(key)) return null;
        return this._loadSaveEntry(this._gameSaves[key]);
    }

    getSavedGameInfo() {
        if (!this._lastGameKey || !this._gameSaves[this._lastGameKey]) return { exists: false };
        if (!this._ensureResumableOrDrop(this._lastGameKey)) return { exists: false };
        return this._buildSaveInfo(this._gameSaves[this._lastGameKey]);
    }

    getSavedGameInfoForKey(key) {
        if (!this._gameSaves[key]) return { exists: false };
        if (!this._ensureResumableOrDrop(key)) return { exists: false };
        return this._buildSaveInfo(this._gameSaves[key]);
    }

    hasSavedGameForLevel(gridData) {
        const key = this.gridDataKey(gridData);
        if (!this._gameSaves[key]) return false;
        return this._ensureResumableOrDrop(key);
    }

    hasSavedGameForCurrentSelection(gridData) {
        // Custom games always save to 'custom' slot; check that slot directly.
        const entry = this._gameSaves['custom'];
        if (!entry) return false;
        if (!this._ensureResumableOrDrop('custom')) return false;
        return entry.w === gridData.w && entry.h === gridData.h && entry.density === gridData.density;
    }

    hasSavedCustomGame() {
        return !!this._gameSaves['custom'];
    }

    lastGameKey() {
        return this._lastGameKey;
    }

    clearGameSave(key) {
        if (!this._gameSaves[key]) return;
        delete this._gameSaves[key];
        if (this._lastGameKey === key) this._lastGameKey = '';
        this._saveGameSaves();
    }

    clearLastGamePointer() {
        this._lastGameKey = '';
        this._saveGameSaves();
    }

    clearSavedGame() {
        // Legacy compat: clears last game's save + pointer
        if (this._lastGameKey) {
            this.clearGameSave(this._lastGameKey);
        }
    }

    // ========================================================================
    // Level progress + best times (mirrors Qt SettingsManager)
    // ========================================================================

    _loadProgressData(variant = 'normal') {
        try {
            const raw = localStorage.getItem(progressStorageKeyForVariant(variant));
            if (!raw) return { progress: {}, bestTimes: {} };
            const parsed = JSON.parse(raw);
            return {
                progress:  parsed.progress  || {},
                bestTimes: parsed.bestTimes || {},
            };
        } catch {
            return { progress: {}, bestTimes: {} };
        }
    }

    _saveProgressData(data, variant = 'normal') {
        try {
            localStorage.setItem(progressStorageKeyForVariant(variant), JSON.stringify(data));
        } catch {}
    }

    saveLevelProgress(gridData, percentage, timeMs = -1) {
        if (!this.isKnownLevelPreset(gridData)) return;

        percentage = Math.max(0, Math.min(100, percentage));
        const key = this.gridDataKey(gridData);
        const data = this._loadProgressData('normal');
        let changed = false;

        const currentProgress = data.progress[key] || 0;
        if (percentage > currentProgress) {
            data.progress[key] = percentage;
            changed = true;
        }

        if (percentage === 100 && timeMs >= 0) {
            const currentBest = data.bestTimes[key];
            if (currentBest === undefined || timeMs < currentBest) {
                data.bestTimes[key] = timeMs;
                changed = true;
            }
        }

        if (changed) {
            this._saveProgressData(data, 'normal');
        }
    }

    getLevelProgress(gridData) {
        const data = this._loadProgressData('normal');
        return data.progress[this.gridDataKey(gridData)] || 0;
    }

    getLevelBestTime(gridData) {
        const data = this._loadProgressData('normal');
        return data.bestTimes[this.gridDataKey(gridData)] ?? null;
    }

    // ========================================================================
    // Online game settings persistence
    // ========================================================================

    /** Save online game settings (used when hosting) */
    saveOnlineGameSettings(gameData, visibility) {
        this.settings['online/gridWidth'] = gameData.grid.w;
        this.settings['online/gridHeight'] = gameData.grid.h;
        this.settings['online/mineDensity'] = gameData.grid.density;
        this.settings['online/gameType'] = gameData.gameType;
        this.settings['online/lobbyVisibility'] = visibility;
        this._saveSettings();
    }

    /** Load saved online game settings, or null if none */
    loadOnlineGameSettings() {
        return {
            gameData: {
                gameType: this.settings['online/gameType'] ?? 0,
                grid: {
                    w: this.settings['online/gridWidth'] ?? 20,
                    h: this.settings['online/gridHeight'] ?? 20,
                    density: this.settings['online/mineDensity'] ?? 20,
                },
            },
            visibility: this.settings['online/lobbyVisibility'] ?? 0,
        };
    }

    // ========================================================================
    // Clear all progress
    // ========================================================================

    /** Clear all progress data (level progress + best times) */
    clearAllProgress() {
        localStorage.removeItem(progressStorageKeyForVariant('normal'));
        for (const mode of OTHER_GAME_MODES) {
            localStorage.removeItem(progressStorageKeyForVariant(mode.id));
        }
    }

    // ========================================================================
    // Reset all settings
    // ========================================================================

    /** Reset all app settings to their defaults (mirrors Qt UIManager::resetAllSettings). */
    resetAllSettings() {
        localStorage.removeItem(SETTINGS_STORAGE_KEY);
        this.settings = { ...DEFAULT_SETTINGS };
    }

    // ========================================================================
    // Infinite mode saves + preset score tracking
    // ========================================================================

    isInfinitePresetDensity(density) {
        return INFINITE_PRESET_DENSITIES.includes(Number(density));
    }

    resolveInfiniteSaveKey(density, treatAsPreset) {
        const d = Math.max(15, Math.min(40, Number(density) || 20));
        if (treatAsPreset && this.isInfinitePresetDensity(d)) return `d${d}`;
        return 'custom';
    }

    _loadInfiniteStore() {
        const key = gameSaveStorageKeyForVariant('infinite_minesweeper');
        const empty = { version: 3, lastGameKey: '', entries: {}, presetScores: {} };

        try {
            const raw = localStorage.getItem(key);
            if (!raw) return empty;

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return empty;

            // Backward compatibility: v2 shape used generic saves only.
            if (parsed.version === 2) {
                return {
                    version: 3,
                    lastGameKey: typeof parsed.lastGameKey === 'string' ? parsed.lastGameKey : '',
                    entries: parsed.saves && typeof parsed.saves === 'object' ? parsed.saves : {},
                    presetScores: {},
                };
            }

            if (parsed.version !== 3) return empty;

            return {
                version: 3,
                lastGameKey: typeof parsed.lastGameKey === 'string' ? parsed.lastGameKey : '',
                entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
                presetScores: parsed.presetScores && typeof parsed.presetScores === 'object' ? parsed.presetScores : {},
            };
        } catch {
            return empty;
        }
    }

    _saveInfiniteStore(store) {
        try {
            localStorage.setItem(
                gameSaveStorageKeyForVariant('infinite_minesweeper'),
                JSON.stringify({
                    version: 3,
                    lastGameKey: store.lastGameKey || '',
                    entries: store.entries || {},
                    presetScores: store.presetScores || {},
                })
            );
        } catch {}
    }

    _normalizeInfiniteChunkCells(rawCells) {
        let bytes = null;

        if (rawCells instanceof Uint8Array) {
            bytes = rawCells;
        } else if (Array.isArray(rawCells)) {
            bytes = new Uint8Array(rawCells.length);
            for (let i = 0; i < rawCells.length; i++) bytes[i] = Number(rawCells[i]) & 0xFF;
        } else if (typeof rawCells === 'string') {
            bytes = decodeBase64ToByteArray(rawCells);
        }

        if (!bytes) return null;

        // Keep fixed 32x32 binary chunk payload.
        if (bytes.length === INFINITE_CHUNK_CELLS) return bytes;
        const fixed = new Uint8Array(INFINITE_CHUNK_CELLS);
        fixed.set(bytes.subarray(0, Math.min(bytes.length, fixed.length)));
        return fixed;
    }

    _buildInfiniteEntry(saveData, elapsedTimeMs) {
        const density = Math.max(15, Math.min(40, Number(saveData?.density) || 20));
        const score = Math.max(0, Number(saveData?.score) || 0);
        const gameState = Number(saveData?.gameState) || 0;
        const hasLastReveal = !!saveData?.hasLastReveal;
        const lastRevealX = Number(saveData?.lastRevealX) || 0;
        const lastRevealY = Number(saveData?.lastRevealY) || 0;

        const chunks = [];
        const sourceChunks = Array.isArray(saveData?.chunks) ? saveData.chunks : [];

        for (const chunk of sourceChunks) {
            const chunkX = Number(chunk?.chunkX) || 0;
            const chunkY = Number(chunk?.chunkY) || 0;
            const bytes = this._normalizeInfiniteChunkCells(chunk?.cells);
            if (!bytes) continue;
            chunks.push({
                chunkX,
                chunkY,
                cells: encodeByteArrayToBase64(bytes),
            });
        }

        chunks.sort((a, b) => (a.chunkY === b.chunkY ? a.chunkX - b.chunkX : a.chunkY - b.chunkY));

        return {
            density,
            elapsedTimeMs: Math.max(0, Number(elapsedTimeMs) || 0),
            score,
            gameState,
            hasLastReveal,
            lastRevealX,
            lastRevealY,
            chunks,
        };
    }

    _entryToInfiniteSaveData(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const chunks = [];
        const sourceChunks = Array.isArray(entry.chunks) ? entry.chunks : [];
        for (const chunk of sourceChunks) {
            const bytes = this._normalizeInfiniteChunkCells(chunk?.cells);
            if (!bytes || bytes.length !== INFINITE_CHUNK_CELLS) return null;
            chunks.push({
                chunkX: Number(chunk?.chunkX) || 0,
                chunkY: Number(chunk?.chunkY) || 0,
                cells: bytes,
            });
        }

        return {
            density: Math.max(15, Math.min(40, Number(entry.density) || 20)),
            score: Math.max(0, Number(entry.score) || 0),
            gameState: Number(entry.gameState) || 0,
            hasLastReveal: !!entry.hasLastReveal,
            lastRevealX: Number(entry.lastRevealX) || 0,
            lastRevealY: Number(entry.lastRevealY) || 0,
            chunks,
        };
    }

    _buildInfiniteSaveInfo(saveKey, entry, presetScores) {
        const info = {
            exists: true,
            density: Math.max(15, Math.min(40, Number(entry?.density) || 20)),
            elapsedTimeMs: Math.max(0, Number(entry?.elapsedTimeMs) || 0),
            currentScore: Math.max(0, Number(entry?.score) || 0),
            score: Math.max(0, Number(entry?.score) || 0),
            width: 0,
            height: 0,
            mineCount: 0,
            isInfinite: true,
            saveKey,
            categoryName: saveKey === 'custom' ? '' : 'Infinite Minesweeper',
            levelName: saveKey === 'custom' ? '' : `${Math.max(15, Math.min(40, Number(entry?.density) || 20))}%`,
            lastScore: 0,
            highScore: 0,
        };

        if (saveKey !== 'custom' && this.isInfinitePresetDensity(info.density)) {
            const score = presetScores[String(info.density)] || { lastScore: 0, highScore: 0 };
            info.lastScore = Math.max(0, Number(score.lastScore) || 0);
            info.highScore = Math.max(0, Number(score.highScore) || 0);
        }

        return info;
    }

    saveInfiniteGameForKey(saveKey, saveData, elapsedTimeMs) {
        if (!saveKey || !saveData) return;

        const store = this._loadInfiniteStore();
        store.entries[saveKey] = this._buildInfiniteEntry(saveData, elapsedTimeMs);
        store.lastGameKey = saveKey;
        this._saveInfiniteStore(store);
    }

    loadInfiniteGameForKey(saveKey) {
        const store = this._loadInfiniteStore();
        const entry = store.entries[saveKey];
        if (!entry) return null;

        const saveData = this._entryToInfiniteSaveData(entry);
        if (!saveData) {
            delete store.entries[saveKey];
            if (store.lastGameKey === saveKey) store.lastGameKey = '';
            this._saveInfiniteStore(store);
            return null;
        }

        return {
            saveData,
            elapsedTimeMs: Math.max(0, Number(entry.elapsedTimeMs) || 0),
            key: saveKey,
        };
    }

    loadInfiniteLastGame() {
        const store = this._loadInfiniteStore();
        if (!store.lastGameKey) return null;
        return this.loadInfiniteGameForKey(store.lastGameKey);
    }

    clearInfiniteGameSave(saveKey) {
        const store = this._loadInfiniteStore();
        if (!store.entries[saveKey]) return;
        delete store.entries[saveKey];
        if (store.lastGameKey === saveKey) store.lastGameKey = '';
        this._saveInfiniteStore(store);
    }

    clearInfiniteLastGamePointer() {
        const store = this._loadInfiniteStore();
        if (!store.lastGameKey) return;
        store.lastGameKey = '';
        this._saveInfiniteStore(store);
    }

    hasInfiniteSavedCustomGame() {
        const store = this._loadInfiniteStore();
        return !!store.entries.custom;
    }

    hasInfiniteSavedGameForDensity(density) {
        const key = this.resolveInfiniteSaveKey(density, true);
        const store = this._loadInfiniteStore();
        return !!store.entries[key];
    }

    getInfiniteSavedGameInfo() {
        const store = this._loadInfiniteStore();
        const key = store.lastGameKey;
        if (!key || !store.entries[key]) {
            return {
                exists: false,
                density: 0,
                elapsedTimeMs: 0,
                currentScore: 0,
                lastScore: 0,
                highScore: 0,
            };
        }
        return this._buildInfiniteSaveInfo(key, store.entries[key], store.presetScores || {});
    }

    getInfiniteSavedGameInfoForKey(saveKey) {
        const store = this._loadInfiniteStore();
        const entry = store.entries[saveKey];
        if (!entry) return { exists: false };
        return this._buildInfiniteSaveInfo(saveKey, entry, store.presetScores || {});
    }

    saveInfinitePresetScore(density, score) {
        const d = Math.max(15, Math.min(40, Number(density) || 20));
        if (!this.isInfinitePresetDensity(d)) return;

        const store = this._loadInfiniteStore();
        const key = String(d);
        const existing = store.presetScores[key] || { lastScore: 0, highScore: 0 };
        const lastScore = Math.max(0, Number(score) || 0);
        const highScore = Math.max(Math.max(0, Number(existing.highScore) || 0), lastScore);
        store.presetScores[key] = { lastScore, highScore };
        this._saveInfiniteStore(store);
    }

    getInfinitePresetScoreInfo(density) {
        const d = Math.max(15, Math.min(40, Number(density) || 20));
        const store = this._loadInfiniteStore();
        const score = store.presetScores[String(d)] || { lastScore: 0, highScore: 0 };
        return {
            lastScore: Math.max(0, Number(score.lastScore) || 0),
            highScore: Math.max(0, Number(score.highScore) || 0),
        };
    }

    // ========================================================================
    // Game mode save/progress (mirrors Qt per-mode file separation)
    // ========================================================================

    _getGameModeSavesKey(gameModeId) {
        return gameSaveStorageKeyForVariant(gameModeId);
    }

    _getGameModeProgressKey(gameModeId) {
        return progressStorageKeyForVariant(gameModeId);
    }

    _loadGameModeSaves(gameModeId) {
        if (gameModeId === 'infinite_minesweeper') {
            const store = this._loadInfiniteStore();
            return { saves: store.entries, lastGameKey: store.lastGameKey };
        }
        try {
            const raw = localStorage.getItem(this._getGameModeSavesKey(gameModeId));
            if (!raw) return { saves: {}, lastGameKey: '' };
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 2) return { saves: {}, lastGameKey: '' };
            return { saves: parsed.saves || {}, lastGameKey: parsed.lastGameKey || '' };
        } catch {
            return { saves: {}, lastGameKey: '' };
        }
    }

    _saveGameModeSaves(gameModeId, saves, lastGameKey) {
        if (gameModeId === 'infinite_minesweeper') {
            const store = this._loadInfiniteStore();
            store.entries = saves || {};
            store.lastGameKey = lastGameKey || '';
            this._saveInfiniteStore(store);
            return;
        }
        try {
            localStorage.setItem(this._getGameModeSavesKey(gameModeId), JSON.stringify({
                version: 2,
                lastGameKey,
                saves,
            }));
        } catch {}
    }

    resolveGameModeSaveKey(gameModeId, gridData) {
        if (gameModeId === 'infinite_minesweeper') {
            const d = Number(gridData?.density) || 20;
            return this.resolveInfiniteSaveKey(d, this.isKnownGameModePreset(gameModeId, { density: d }));
        }
        return this.isKnownGameModePreset(gameModeId, gridData) ? this.gridDataKey(gridData, gameModeId) : 'custom';
    }

    saveGameModeState(gameModeId, grid, gridData, elapsedTimeMs, fogCache = [], fogCacheLimit = 20) {
        if (gameModeId === 'infinite_minesweeper') {
            const density = Number(gridData?.density) || Number(grid?.density) || 20;
            const isPreset = this.isInfinitePresetDensity(density) && this.isKnownGameModePreset(gameModeId, { density });
            const saveKey = this.resolveInfiniteSaveKey(density, isPreset);
            this.saveInfiniteGameForKey(saveKey, grid, elapsedTimeMs);
            return;
        }
        if (!grid || grid.length === 0) return;
        const key = this.resolveGameModeSaveKey(gameModeId, gridData);
        const { saves } = this._loadGameModeSaves(gameModeId);
        saves[key] = this._buildSaveEntry(grid, gridData, elapsedTimeMs, fogCache, fogCacheLimit);
        this._saveGameModeSaves(gameModeId, saves, key);
    }

    loadGameModeStateForKey(gameModeId, key) {
        if (gameModeId === 'infinite_minesweeper') {
            return this.loadInfiniteGameForKey(key);
        }
        const { saves } = this._loadGameModeSaves(gameModeId);
        if (!saves[key]) return null;
        if (!this._isEntryResumable(saves[key])) {
            delete saves[key];
            this._saveGameModeSaves(gameModeId, saves, '');
            return null;
        }
        return this._loadSaveEntry(saves[key]);
    }

    hasGameModeSavedGame(gameModeId, gridData) {
        if (gameModeId === 'infinite_minesweeper') {
            return this.hasInfiniteSavedGameForDensity(Number(gridData?.density) || 20);
        }
        const key = this.gridDataKey(gridData, gameModeId);
        const { saves } = this._loadGameModeSaves(gameModeId);
        if (!saves[key]) return false;
        const entry = saves[key];
        if (entry.is3D && entry.faces) return this._is3DEntryResumable(entry);
        return this._isEntryResumable(entry);
    }

    getGameModeSavedGameInfo(gameModeId) {
        if (gameModeId === 'infinite_minesweeper') {
            return this.getInfiniteSavedGameInfo();
        }
        const { saves, lastGameKey } = this._loadGameModeSaves(gameModeId);
        if (!lastGameKey || !saves[lastGameKey]) return { exists: false };
        const entry = saves[lastGameKey];
        if (!entry || !entry.w || !entry.h) return { exists: false };
        const isCustom = (lastGameKey === 'custom');

        // 3D entry
        if (entry.is3D && entry.faces) {
            if (!this._is3DEntryResumable(entry)) return { exists: false };
            const gridData = { w: entry.w, h: entry.h, l: entry.l, density: entry.density };
            const totalCells = 2 * (entry.w * entry.h + entry.w * entry.l + entry.h * entry.l);
            const mineCount = Math.min(Math.round(totalCells * entry.density / 100), totalCells - 9);
            return {
                exists: true,
                w: entry.w, h: entry.h, density: entry.density,
                mineCount,
                elapsedTimeMs: entry.elapsedTimeMs || 0,
                levelName: isCustom ? '' : (this.getGameModeLevelName(gameModeId, gridData) || 'Custom level'),
            };
        }

        // 2D entry
        if (!this._isEntryResumable(entry)) return { exists: false };
        let mineCount = 0;
        for (const c of entry.cells) { if (c.hasMine) mineCount++; }
        const gridData = { w: entry.w, h: entry.h, density: entry.density };
        return {
            exists: true,
            w: entry.w,
            h: entry.h,
            density: entry.density,
            mineCount,
            elapsedTimeMs: entry.elapsedTimeMs || 0,
            levelName: isCustom ? '' : (this.getGameModeLevelName(gameModeId, gridData) || 'Custom level'),
        };
    }

    loadGameModeLastGameState(gameModeId) {
        if (gameModeId === 'infinite_minesweeper') {
            return this.loadInfiniteLastGame();
        }
        const { saves, lastGameKey } = this._loadGameModeSaves(gameModeId);
        if (!lastGameKey || !saves[lastGameKey]) return null;
        if (!this._isEntryResumable(saves[lastGameKey])) return null;
        const result = this._loadSaveEntry(saves[lastGameKey]);
        if (result) result.key = lastGameKey;
        return result;
    }

    clearGameModeSave(gameModeId, key) {
        if (gameModeId === 'infinite_minesweeper') {
            this.clearInfiniteGameSave(key);
            return;
        }
        const { saves, lastGameKey } = this._loadGameModeSaves(gameModeId);
        if (!saves[key]) return;
        delete saves[key];
        const newLastKey = (lastGameKey === key) ? '' : lastGameKey;
        this._saveGameModeSaves(gameModeId, saves, newLastKey);
    }

    // ── 3D game mode save/load ──

    saveGameModeState3D(gameModeId, grid3DState, elapsedTimeMs) {
        const gridData = { w: grid3DState.w, h: grid3DState.h, l: grid3DState.l, density: grid3DState.density };
        const key = this.resolveGameModeSaveKey(gameModeId, gridData);
        const { saves } = this._loadGameModeSaves(gameModeId);
        saves[key] = { ...grid3DState, elapsedTimeMs, is3D: true };
        this._saveGameModeSaves(gameModeId, saves, key);
    }

    loadGameModeState3DForKey(gameModeId, key) {
        const { saves } = this._loadGameModeSaves(gameModeId);
        const entry = saves[key];
        if (!entry || !entry.faces || !entry.is3D) return null;
        if (!this._is3DEntryResumable(entry)) {
            delete saves[key];
            this._saveGameModeSaves(gameModeId, saves, '');
            return null;
        }
        return { grid3DState: entry, elapsedTimeMs: entry.elapsedTimeMs || 0 };
    }

    loadGameModeLastGameState3D(gameModeId) {
        const { saves, lastGameKey } = this._loadGameModeSaves(gameModeId);
        if (!lastGameKey || !saves[lastGameKey]) return null;
        const entry = saves[lastGameKey];
        if (!entry || !entry.faces || !entry.is3D) return null;
        if (!this._is3DEntryResumable(entry)) return null;
        return { grid3DState: entry, elapsedTimeMs: entry.elapsedTimeMs || 0, key: lastGameKey };
    }

    hasGameModeSavedGame3D(gameModeId, gridData) {
        const key = this.gridDataKey(gridData, gameModeId);
        const { saves } = this._loadGameModeSaves(gameModeId);
        const entry = saves[key];
        if (!entry || !entry.faces || !entry.is3D) return false;
        return this._is3DEntryResumable(entry);
    }

    _is3DEntryResumable(entry) {
        if (!entry || !entry.faces) return false;
        let hasHiddenSafe = false;
        let hasRevealedMine = false;
        for (const faceArr of entry.faces) {
            for (const cell of faceArr) {
                const isMine = cell.c === 2; // CellContent.Mine
                const isRevealed = cell.s === 1; // CellState.Revealed
                const isHidden = cell.s === 0; // CellState.Hidden
                if (!isMine && isHidden) hasHiddenSafe = true;
                if (isMine && isRevealed) { hasRevealedMine = true; break; }
            }
            if (hasRevealedMine) break;
        }
        return hasHiddenSafe && !hasRevealedMine;
    }

    saveGameModeProgress(gameModeId, gridData, percentage, timeMs = -1) {
        if (gameModeId === 'infinite_minesweeper') return;
        if (!this.isKnownGameModePreset(gameModeId, gridData)) return;

        percentage = Math.max(0, Math.min(100, percentage));
        const key = this.gridDataKey(gridData, gameModeId);
        const data = this._loadGameModeProgressData(gameModeId);
        let changed = false;

        const currentProgress = data.progress[key] || 0;
        if (percentage > currentProgress) {
            data.progress[key] = percentage;
            changed = true;
        }

        if (percentage === 100 && timeMs >= 0) {
            const currentBest = data.bestTimes[key];
            if (currentBest === undefined || timeMs < currentBest) {
                data.bestTimes[key] = timeMs;
                changed = true;
            }
        }

        if (changed) {
            this._saveGameModeProgressData(gameModeId, data);
        }
    }

    getGameModeProgress(gameModeId, gridData) {
        if (gameModeId === 'infinite_minesweeper') return 0;
        const data = this._loadGameModeProgressData(gameModeId);
        return data.progress[this.gridDataKey(gridData, gameModeId)] || 0;
    }

    getGameModeBestTime(gameModeId, gridData) {
        if (gameModeId === 'infinite_minesweeper') return null;
        const data = this._loadGameModeProgressData(gameModeId);
        return data.bestTimes[this.gridDataKey(gridData, gameModeId)] ?? null;
    }

    _loadGameModeProgressData(gameModeId) {
        return this._loadProgressData(gameModeId);
    }

    _saveGameModeProgressData(gameModeId, data) {
        this._saveProgressData(data, gameModeId);
    }

    // ── Game mode custom settings ──

    saveGameModeCustomSettings(gameModeId, settings) {
        const prefix = `gameModeCustom/${gameModeId}/`;
        for (const key of Object.keys(this.settings)) {
            if (key.startsWith(prefix)) {
                delete this.settings[key];
            }
        }

        for (const [k, v] of Object.entries(settings || {})) {
            this.settings[prefix + k] = v;
        }
        this._saveSettings();
    }

    loadGameModeCustomSettings(gameModeId) {
        const prefix = `gameModeCustom/${gameModeId}/`;
        const result = {};
        for (const [k, v] of Object.entries(this.settings)) {
            if (k.startsWith(prefix)) {
                result[k.substring(prefix.length)] = v;
            }
        }
        return Object.keys(result).length ? result : null;
    }
}
