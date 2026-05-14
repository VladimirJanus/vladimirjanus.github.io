// SettingsManager.js - Persistent settings via localStorage
// ============================================================================

import {
    LEVEL_PRESETS, OTHER_GAME_MODES,
    NET_PLAYER_NAME_LENGTH,
    GRID_NORMAL_DEFAULT_W, GRID_NORMAL_DEFAULT_H, GRID_NORMAL_DEFAULT_DENSITY,
    GRID_3D_DEFAULT_W, GRID_3D_DEFAULT_H, GRID_3D_DEFAULT_L, GRID_3D_DEFAULT_DENSITY,
    GRID_FOG_OF_WAR_DEFAULT_W, GRID_FOG_OF_WAR_DEFAULT_H,
    GRID_FOG_OF_WAR_DEFAULT_DENSITY, GRID_FOG_OF_WAR_DEFAULT_VISIBLE_CELLS,
} from '../core/CoreData.js';
import { CellContent, CellState, GameType, GameVariant, gameVariantToId, gameVariantFromId } from '../core/CoreEnums.js';
import { normalizeGameData, isGameTypeVariantSupported } from '../core/CoreTypes.js';

const SETTINGS_STORAGE_KEY = 'settings.json';
const SESSION_KEY_STORAGE_KEY = 'network/sessionKey';
const COOLDOWNS_STORAGE_KEY = 'cooldowns.dat';
const USER_SET_NAME_KEY = 'player/userSetName';

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
    'online/gameVariant': GameVariant.normal,
    'online/gridLength': 5,
    'online/visibleCells': 20,
    'online/gameType': 0,
    'online/teamCount': 2,
    'online/allowTeamSwitching': false,
    'online/lobbyVisibility': 0,
    'lobby/autoApprovePending': false,
    'app/killed': false,
    'cachedServerIp': '',
    'cachedServerPort': 8080,
});

const SETTINGS_KEY_ALIASES = Object.freeze({
    playerName: 'player/nickname',
    userSetName: USER_SET_NAME_KEY,
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

function normalizeNicknameForProtocol(nickname) {
    return String(nickname ?? '').trim().slice(0, NET_PLAYER_NAME_LENGTH);
}

function onlineGridSettingsModeId(gameType) {
    switch (Number(gameType)) {
        case GameType.CoOpHard:
        case GameType.CoOpSoft:
            return 'coop';
        case GameType.PVPDuel:
            return 'pvpduel';
        case GameType.PVPTeams:
            return 'pvpteams';
        case GameType.PVPConquest:
            return 'pvpconquest';
        default:
            return 'coop';
    }
}

function onlineGridSettingsVariantId(variant) {
    return gameVariantToId(variant) || 'normal';
}

function onlineGridSettingsPrefix(gameType, variant) {
    return `online/grid/${onlineGridSettingsModeId(gameType)}/${onlineGridSettingsVariantId(variant)}/`;
}

function legacyOnlineGridSettingsPrefix(variant) {
    return `online/grid/${onlineGridSettingsVariantId(variant)}/`;
}

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

function normalizeGameModeId(gameModeId) {
    if (gameModeId === 'minesweeper_3d') return 'Cuboid';
    if (gameModeId === 'fog_of_war') return 'FOW';
    if (gameModeId === 'infinite_minesweeper') return 'infinite';
    return gameModeId;
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
        const resolvedKey = this._resolveSettingKey(key);
        if (resolvedKey === 'player/nickname') {
            return normalizeNicknameForProtocol(this.settings[resolvedKey]);
        }
        return this.settings[resolvedKey];
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
        const resolvedKey = this._resolveSettingKey(key);
        if (resolvedKey === 'player/nickname') {
            this.saveNickname(value);
            return;
        }
        this.settings[resolvedKey] = value;
        this._saveSettings();
    }

    has(key) {
        return Object.prototype.hasOwnProperty.call(this.settings, this._resolveSettingKey(key));
    }

    saveNickname(nickname) {
        const normalized = normalizeNicknameForProtocol(nickname);
        if (!normalized) return false;

        this.settings['player/nickname'] = normalized;
        if (normalized.length >= 2) {
            this.settings[USER_SET_NAME_KEY] = true;
        }
        this._saveSettings();
        return true;
    }

    setUserSetName(userSetName) {
        this.settings[USER_SET_NAME_KEY] = userSetName === true;
        this._saveSettings();
    }

    shouldPromptForPlayerNameOnStartup() {
        if (!this.has('userSetName')) {
            const hasCustomSavedName = normalizeNicknameForProtocol(this.settings['player/nickname']) !== 'Player';
            this.setUserSetName(hasCustomSavedName);
            return !hasCustomSavedName;
        }
        return this.settings[USER_SET_NAME_KEY] !== true;
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

    setKilled(killed) {
        this.settings['app/killed'] = !!killed;
        this._saveSettings();
    }

    isKilled() {
        return this.settings['app/killed'] === true;
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
        gameModeId = normalizeGameModeId(gameModeId);
        const mode = OTHER_GAME_MODES.find(m => m.id === gameModeId);
        if (!mode) return null;
        for (const cat of mode.categories) {
            for (const lv of cat.levels) {
                if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
            return `d${gridData.density}`;
        }
        if (gameModeId === 'FOW') {
            const level = this._findGameModeLevel(gameModeId, gridData);
            const visibleCells = Number.isFinite(Number(gridData.visibleCells))
                ? Number(gridData.visibleCells)
                : (level && Number.isFinite(level.visibleCells) ? Number(level.visibleCells) : 0);
            return `${gridData.w}x${gridData.h}x${gridData.density}x${visibleCells}`;
        } else if (gameModeId === 'Cuboid') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        const mode = OTHER_GAME_MODES.find(m => m.id === gameModeId);
        if (!mode) return null;
        for (const cat of mode.categories) {
            for (const lv of cat.levels) {
                if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        const mode = OTHER_GAME_MODES.find(m => m.id === gameModeId);
        if (!mode) return null;
        for (const cat of mode.categories) {
            for (const lv of cat.levels) {
                if (gameModeId === 'infinite') {
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
        const visibleCells = Number(gridData.visibleCells ?? fogCacheLimit);
        if (Number.isFinite(visibleCells) && visibleCells > 0) {
            entry.visibleCells = visibleCells;
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
            gridData: { w, h, density: entry.density, visibleCells: entry.visibleCells || entry.fogCacheLimit || 20 },
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
            const legacyVariant = variant === 'Cuboid' ? 'minesweeper_3d'
                : variant === 'FOW' ? 'fog_of_war'
                : variant === 'infinite' ? 'infinite_minesweeper'
                : null;
            const raw = localStorage.getItem(progressStorageKeyForVariant(variant)) ||
                (legacyVariant ? localStorage.getItem(progressStorageKeyForVariant(legacyVariant)) : null);
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
        gameData = normalizeGameData(gameData);
        let variant = gameData.grid.variant ?? GameVariant.normal;
        if (!isGameTypeVariantSupported(gameData.gameType, variant))
            variant = GameVariant.normal;
        const prefix = onlineGridSettingsPrefix(gameData.gameType, variant);

        this.settings[`${prefix}w`] = gameData.grid.w;
        this.settings[`${prefix}h`] = gameData.grid.h;
        this.settings[`${prefix}d`] = gameData.grid.density;
        if (variant === GameVariant.Cuboid)
            this.settings[`${prefix}l`] = gameData.grid.l ?? GRID_3D_DEFAULT_L;
        if (variant === GameVariant.FOW)
            this.settings[`${prefix}visibleCells`] = gameData.grid.visibleCells ?? GRID_FOG_OF_WAR_DEFAULT_VISIBLE_CELLS;

        this.settings['online/gridWidth'] = gameData.grid.w;
        this.settings['online/gridHeight'] = gameData.grid.h;
        this.settings['online/mineDensity'] = gameData.grid.density;
        this.settings['online/gameVariant'] = variant;
        this.settings['online/gridLength'] = gameData.grid.l ?? 5;
        this.settings['online/visibleCells'] = gameData.grid.visibleCells ?? 20;
        this.settings['online/gameType'] = gameData.gameType;
        this.settings['online/teamCount'] = gameData.teamCount;
        this.settings['online/allowTeamSwitching'] = gameData.allowTeamSwitching;
        this.settings['online/lobbyVisibility'] = visibility;
        this._saveSettings();
    }

    onlineGridDataForVariant(variant, gameType = this.settings['online/gameType'] ?? GameType.CoOpHard) {
        variant = Number(variant);
        gameType = Number(gameType);
        if (!isGameTypeVariantSupported(gameType, variant))
            variant = GameVariant.normal;

        const prefix = onlineGridSettingsPrefix(gameType, variant);
        const legacyPrefix = legacyOnlineGridSettingsPrefix(variant);
        const read = (name, globalKey, fallback) => this.settings[`${prefix}${name}`]
            ?? this.settings[`${legacyPrefix}${name}`]
            ?? this.settings[globalKey]
            ?? fallback;

        if (variant === GameVariant.FOW) {
            return {
                variant,
                w: read('w', 'online/gridWidth', GRID_FOG_OF_WAR_DEFAULT_W),
                h: read('h', 'online/gridHeight', GRID_FOG_OF_WAR_DEFAULT_H),
                density: read('d', 'online/mineDensity', GRID_FOG_OF_WAR_DEFAULT_DENSITY),
                l: 0,
                visibleCells: read('visibleCells', 'online/visibleCells', GRID_FOG_OF_WAR_DEFAULT_VISIBLE_CELLS),
            };
        }

        if (variant === GameVariant.Cuboid) {
            return {
                variant,
                w: read('w', 'online/gridWidth', GRID_3D_DEFAULT_W),
                h: read('h', 'online/gridHeight', GRID_3D_DEFAULT_H),
                density: read('d', 'online/mineDensity', GRID_3D_DEFAULT_DENSITY),
                l: read('l', 'online/gridLength', GRID_3D_DEFAULT_L),
                visibleCells: 0,
            };
        }

        return {
            variant: GameVariant.normal,
            w: read('w', 'online/gridWidth', GRID_NORMAL_DEFAULT_W),
            h: read('h', 'online/gridHeight', GRID_NORMAL_DEFAULT_H),
            density: read('d', 'online/mineDensity', GRID_NORMAL_DEFAULT_DENSITY),
            l: 0,
            visibleCells: 0,
        };
    }

    saveOnlineGridSettingsDraft(grid, gameType) {
        let variant = grid.variant ?? GameVariant.normal;
        if (!isGameTypeVariantSupported(gameType, variant))
            return;

        const prefix = onlineGridSettingsPrefix(gameType, variant);
        this.settings[`${prefix}w`] = grid.w;
        this.settings[`${prefix}h`] = grid.h;
        this.settings[`${prefix}d`] = grid.density;
        if (variant === GameVariant.Cuboid)
            this.settings[`${prefix}l`] = grid.l ?? GRID_3D_DEFAULT_L;
        if (variant === GameVariant.FOW)
            this.settings[`${prefix}visibleCells`] = grid.visibleCells ?? GRID_FOG_OF_WAR_DEFAULT_VISIBLE_CELLS;
        this._saveSettings();
    }

    /** Load saved online game settings, or null if none */
    loadOnlineGameSettings() {
        const gameType = this.settings['online/gameType'] ?? GameType.CoOpHard;
        const requestedVariant = this.settings['online/gameVariant'] ?? GameVariant.normal;
        const variant = isGameTypeVariantSupported(gameType, requestedVariant) ? requestedVariant : GameVariant.normal;
        const gameData = normalizeGameData({
                gameType,
                teamCount: this.settings['online/teamCount'] ?? 2,
                allowTeamSwitching: this.settings['online/allowTeamSwitching'] === true,
                grid: this.onlineGridDataForVariant(variant, gameType),
            });
        return {
            gameData,
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
    // Game variant switching  (mirrors Qt SettingsManager::switchGameVariant)
    // ========================================================================

    switchGameVariant(v) {
        this.set('activeGameVariant', v);
    }

    activeGameVariant() {
        const v = this.get('activeGameVariant');
        return (v !== undefined && v !== null) ? v : GameVariant.normal;
    }

    getGameMode(v) {
        const id = gameVariantToId(v);
        return OTHER_GAME_MODES.find(m => m.id === id) || null;
    }

    // ========================================================================
    // Infinite mode saves + preset score tracking
    // ========================================================================

    isInfinitePresetDensity(density) {
        return INFINITE_PRESET_DENSITIES.includes(Number(density));
    }

    resolveInfiniteSaveKey(density, treatAsPreset) {
        const d = Math.max(15, Math.min(40, Number(density) || 20));
        if (treatAsPreset && this.isInfinitePresetDensity(d)) return `infinite_${d}`;
        return 'custom';
    }

    _normalizeInfiniteSaveKey(saveKey) {
        const key = typeof saveKey === 'string' ? saveKey : '';
        const legacyDensity = /^d(\d+)$/.exec(key);
        return legacyDensity ? `infinite_${legacyDensity[1]}` : key;
    }

    _normalizeInfiniteStore(store) {
        const entries = {};
        for (const [key, entry] of Object.entries(store.entries || {})) {
            const normalizedKey = this._normalizeInfiniteSaveKey(key);
            entries[normalizedKey] = entries[normalizedKey] || entry;
        }
        return {
            version: 3,
            lastGameKey: this._normalizeInfiniteSaveKey(store.lastGameKey || ''),
            entries,
            presetScores: store.presetScores || {},
        };
    }

    _loadInfiniteStore() {
        const key = gameSaveStorageKeyForVariant('infinite');
        const legacyKey = gameSaveStorageKeyForVariant('infinite_minesweeper');
        const empty = { version: 3, lastGameKey: '', entries: {}, presetScores: {} };

        try {
            const raw = localStorage.getItem(key) || localStorage.getItem(legacyKey);
            if (!raw) return empty;

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return empty;

            // Backward compatibility: v2 shape used generic saves only.
            if (parsed.version === 2) {
                return this._normalizeInfiniteStore({
                    version: 3,
                    lastGameKey: typeof parsed.lastGameKey === 'string' ? parsed.lastGameKey : '',
                    entries: parsed.saves && typeof parsed.saves === 'object' ? parsed.saves : {},
                    presetScores: {},
                });
            }

            if (parsed.version !== 3) return empty;

            return this._normalizeInfiniteStore({
                version: 3,
                lastGameKey: typeof parsed.lastGameKey === 'string' ? parsed.lastGameKey : '',
                entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
                presetScores: parsed.presetScores && typeof parsed.presetScores === 'object' ? parsed.presetScores : {},
            });
        } catch {
            return empty;
        }
    }

    _saveInfiniteStore(store) {
        try {
            localStorage.setItem(
                gameSaveStorageKeyForVariant('infinite'),
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

    _countInfiniteScoreFromChunks(chunks) {
        let score = 0;
        const sourceChunks = Array.isArray(chunks) ? chunks : [];
        for (const chunk of sourceChunks) {
            const bytes = this._normalizeInfiniteChunkCells(chunk?.cells);
            if (!bytes) continue;
            for (const packed of bytes) {
                const content = (packed >> 4) & 0x0F;
                const state = packed & 0x0F;
                if (content === CellContent.Safe && state === CellState.Revealed) score++;
            }
        }
        return score;
    }

    _buildInfiniteEntry(saveData, elapsedTimeMs) {
        const density = Math.max(15, Math.min(40, Number(saveData?.density) || 20));
        const explicitScore = Number(saveData?.score);
        const gameState = Number(saveData?.gameState) || 0;
        const hasLastReveal = !!saveData?.hasLastReveal;
        const lastRevealX = Number(saveData?.lastRevealX) || 0;
        const lastRevealY = Number(saveData?.lastRevealY) || 0;

        const chunks = [];
        const sourceChunks = Array.isArray(saveData?.chunks) ? saveData.chunks : [];

        for (const chunk of sourceChunks) {
            const chunkX = Number(chunk?.chunkX ?? chunk?.cx) || 0;
            const chunkY = Number(chunk?.chunkY ?? chunk?.cy) || 0;
            const bytes = this._normalizeInfiniteChunkCells(chunk?.cells);
            if (!bytes) continue;
            chunks.push({
                cx: chunkX,
                cy: chunkY,
                cells: encodeByteArrayToBase64(bytes),
            });
        }

        chunks.sort((a, b) => (a.cy === b.cy ? a.cx - b.cx : a.cy - b.cy));
        const score = Number.isFinite(explicitScore)
            ? Math.max(0, explicitScore)
            : this._countInfiniteScoreFromChunks(chunks);

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
                chunkX: Number(chunk?.chunkX ?? chunk?.cx) || 0,
                chunkY: Number(chunk?.chunkY ?? chunk?.cy) || 0,
                cells: bytes,
            });
        }

        return {
            density: Math.max(15, Math.min(40, Number(entry.density) || 20)),
            score: Number.isFinite(Number(entry.score))
                ? Math.max(0, Number(entry.score))
                : this._countInfiniteScoreFromChunks(chunks),
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
            currentScore: Number.isFinite(Number(entry?.score))
                ? Math.max(0, Number(entry.score))
                : this._countInfiniteScoreFromChunks(entry?.chunks),
            score: Number.isFinite(Number(entry?.score))
                ? Math.max(0, Number(entry.score))
                : this._countInfiniteScoreFromChunks(entry?.chunks),
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

    updateInfinitePresetHighScore(density, score) {
        const d = Math.max(15, Math.min(40, Number(density) || 20));
        if (!this.isInfinitePresetDensity(d)) return;

        const nextScore = Math.max(0, Number(score) || 0);
        const store = this._loadInfiniteStore();
        const key = String(d);
        const existing = store.presetScores[key] || { lastScore: 0, highScore: 0 };
        const currentHighScore = Math.max(0, Number(existing.highScore) || 0);
        if (nextScore <= currentHighScore) return;

        store.presetScores[key] = {
            lastScore: Math.max(0, Number(existing.lastScore) || 0),
            highScore: nextScore,
        };
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
        gameModeId = normalizeGameModeId(gameModeId);
        return gameSaveStorageKeyForVariant(gameModeId);
    }

    _getGameModeProgressKey(gameModeId) {
        gameModeId = normalizeGameModeId(gameModeId);
        return progressStorageKeyForVariant(gameModeId);
    }

    _loadGameModeSaves(gameModeId) {
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
            const store = this._loadInfiniteStore();
            return { saves: store.entries, lastGameKey: store.lastGameKey };
        }
        try {
            const key = this._getGameModeSavesKey(gameModeId);
            const legacyKey = gameModeId === 'Cuboid' ? gameSaveStorageKeyForVariant('minesweeper_3d')
                : gameModeId === 'FOW' ? gameSaveStorageKeyForVariant('fog_of_war')
                : null;
            const raw = localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : null);
            if (!raw) return { saves: {}, lastGameKey: '' };
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 2) return { saves: {}, lastGameKey: '' };
            return { saves: parsed.saves || {}, lastGameKey: parsed.lastGameKey || '' };
        } catch {
            return { saves: {}, lastGameKey: '' };
        }
    }

    _saveGameModeSaves(gameModeId, saves, lastGameKey) {
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
            const d = Number(gridData?.density) || 20;
            return this.resolveInfiniteSaveKey(d, this.isKnownGameModePreset(gameModeId, { density: d }));
        }
        return this.isKnownGameModePreset(gameModeId, gridData) ? this.gridDataKey(gridData, gameModeId) : 'custom';
    }

    saveGameModeState(gameModeId, grid, gridData, elapsedTimeMs, fogCache = [], fogCacheLimit = 20) {
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
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
                w: entry.w, h: entry.h, l: entry.l, density: entry.density,
                is3D: true,
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') {
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
        gameModeId = normalizeGameModeId(gameModeId);
        const gridData = { w: grid3DState.w, h: grid3DState.h, l: grid3DState.l, density: grid3DState.density };
        const key = this.resolveGameModeSaveKey(gameModeId, gridData);
        const { saves } = this._loadGameModeSaves(gameModeId);
        saves[key] = { ...grid3DState, elapsedTimeMs, is3D: true };
        this._saveGameModeSaves(gameModeId, saves, key);
    }

    loadGameModeState3DForKey(gameModeId, key) {
        gameModeId = normalizeGameModeId(gameModeId);
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
        gameModeId = normalizeGameModeId(gameModeId);
        const { saves, lastGameKey } = this._loadGameModeSaves(gameModeId);
        if (!lastGameKey || !saves[lastGameKey]) return null;
        const entry = saves[lastGameKey];
        if (!entry || !entry.faces || !entry.is3D) return null;
        if (!this._is3DEntryResumable(entry)) return null;
        return { grid3DState: entry, elapsedTimeMs: entry.elapsedTimeMs || 0, key: lastGameKey };
    }

    hasGameModeSavedGame3D(gameModeId, gridData) {
        gameModeId = normalizeGameModeId(gameModeId);
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') return;
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
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') return 0;
        const data = this._loadGameModeProgressData(gameModeId);
        return data.progress[this.gridDataKey(gridData, gameModeId)] || 0;
    }

    getGameModeBestTime(gameModeId, gridData) {
        gameModeId = normalizeGameModeId(gameModeId);
        if (gameModeId === 'infinite') return null;
        const data = this._loadGameModeProgressData(gameModeId);
        return data.bestTimes[this.gridDataKey(gridData, gameModeId)] ?? null;
    }

    _loadGameModeProgressData(gameModeId) {
        gameModeId = normalizeGameModeId(gameModeId);
        return this._loadProgressData(gameModeId);
    }

    _saveGameModeProgressData(gameModeId, data) {
        gameModeId = normalizeGameModeId(gameModeId);
        this._saveProgressData(data, gameModeId);
    }

    // ── Game mode custom settings ──

    saveGameModeCustomSettings(gameModeId, settings) {
        gameModeId = normalizeGameModeId(gameModeId);
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
        gameModeId = normalizeGameModeId(gameModeId);
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
