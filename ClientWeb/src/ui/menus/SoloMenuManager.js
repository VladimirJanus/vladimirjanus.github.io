// SoloMenuManager.js — Solo menu rendering and local game flow
// ============================================================================

import { GameType, LobbyVisibility, CellState } from '../../core/CoreEnums.js';
import { LEVEL_PRESETS, OTHER_GAME_MODES } from '../../core/CoreData.js';

export class SoloMenuManager {
    constructor(ui) {
        this.ui = ui;
        this._expandedCategory = -1;
        this._otherModesExpanded = false;
        this._selectedGameMode = '';
        this._gameModeExpandedCategory = -1;
    }

    // ========================================================================
    // Navigation
    // ========================================================================

    openSoloMenu() {
        // Flush any pending 3D autosave before leaving
        if (this.ui._3dAutosaveTimer) {
            clearTimeout(this.ui._3dAutosaveTimer);
            this.ui._3dAutosaveTimer = null;
            if (this.ui._grid3DManager && !this.ui._grid3DManager.finished
                && this.ui._grid3DManager.gameState === 2 /* GameState.Playing */) {
                const saveData = this.ui._grid3DManager.toSaveJson();
                const elapsed = this.ui.timer.currentGameTimeMs();
                this.ui.settings.saveGameModeState3D('minesweeper_3d', saveData, elapsed);
            }
        }

        // Flush any pending infinite autosave before leaving
        if (this.ui._infiniteAutosaveTimer) {
            clearTimeout(this.ui._infiniteAutosaveTimer);
            this.ui._infiniteAutosaveTimer = null;
            this.ui._flushInfiniteAutosave();
        }

        // Restore game mode sub-view if returning from a game mode game
        if (this.ui._activeGameVariant && !this._selectedGameMode) {
            this._selectedGameMode = this.ui._activeGameVariant;
            this._gameModeExpandedCategory = 0;
        }
        this.ui._activeGameVariant = '';
        this.ui.gridManager.gameVariant = '';
        this.renderSoloMenu();
        this.ui._showScreen('soloMenu');
    }

    // ========================================================================
    // Game start helpers
    // ========================================================================

    /** Start a custom solo game using the current grid settings. */
    startSoloGame() {
        const ui = this.ui;
        const w = ui.settings.get('gridWidth');
        const h = ui.settings.get('gridHeight');
        const d = ui.settings.get('mineDensity');
        // Custom games always save to 'custom'; clear any old custom save.
        ui.settings.setCustomGame(true);
        ui.settings.clearGameSave('custom');
        this._launchLocalGame(w, h, d, 'Custom', 'Custom');
    }

    /** Start a preset solo game with explicit dimensions. */
    startSoloPresetGame(w, h, density, categoryName = '', levelName = '') {
        this.ui.settings.setCustomGame(false);
        this._launchLocalGame(w, h, density, categoryName, levelName);
    }

    _launchLocalGame(w, h, density, categoryName = '', levelName = '') {
        const ui = this.ui;
        const gridData = { w, h, density };
        ui._isContinuedGame = false;
        ui._gamePlayedTracked = false;
        ui.actionHandler._gamePlayedTracked = false;
        ui._pauseCategoryName = categoryName || ui.settings.getLevelCategory(gridData) || 'Custom';
        ui._pauseLevelName = levelName || ui.settings.getLevelShortName(gridData) || 'Custom';
        ui.isInLobby = false;
        ui._duelResult = null;
        ui.modalState.resetDeathState();
        ui.gridRenderer.clearFalseFlags();
        ui.gridManager.initGame(gridData);
        ui.timer.reset();
        ui._updateMinesDisplay(ui.gridManager.minesRemaining);
        ui._showScreen('gameView');
        ui.gridRenderer.centerGrid();
        document.getElementById('networkBar').classList.remove('visible');
        document.getElementById('btnClaimVictory').style.display = 'none';
        ui.gameModal.hideGameModal();
        ui.gameModal.syncPauseButton();
    }

    /** Continue a previously saved solo game (last game). */
    continueGame() {
        const ui   = this.ui;
        ui._isContinuedGame = true;
        ui._gamePlayedTracked = true;
        ui.actionHandler._gamePlayedTracked = true;
        // Restore the custom flag so auto-saves go to the right slot.
        ui.settings.setCustomGame(ui.settings.lastGameKey() === 'custom');
        const save = ui.settings.loadLastGameState();
        if (!save) { ui._showToast('No saved game found'); return; }

        this._resumeFromSave(save);
    }

    /** Continue a specific level's saved game. */
    continueGameForLevel(w, h, density) {
        const ui  = this.ui;
        ui._isContinuedGame = true;
        ui._gamePlayedTracked = true;
        ui.actionHandler._gamePlayedTracked = true;
        // Preset level continue: saves go back to the preset key.
        ui.settings.setCustomGame(false);
        const gd  = { w, h, density };
        const key = ui.settings.resolveGameSaveKey(gd);
        ui._pauseCategoryName = ui.settings.getLevelCategory(gd) || 'Custom';
        ui._pauseLevelName = ui.settings.getLevelShortName(gd) || 'Custom';
        const save = ui.settings.loadGameStateForKey(key);
        if (!save) { ui._showToast('No saved game found for this level'); return; }

        // Update lastGameKey to this game
        ui.settings.saveGameState(save.grid, save.gridData, save.elapsedTimeMs, save.fogCache || [], save.fogCacheLimit);
        this._resumeFromSave(save);
    }

    /** Continue the saved custom game. */
    continueCustomGame() {
        const ui  = this.ui;
        ui._isContinuedGame = true;
        ui._gamePlayedTracked = true;
        ui.actionHandler._gamePlayedTracked = true;
        const gd = {
            w: ui.settings.get('gridWidth'),
            h: ui.settings.get('gridHeight'),
            density: ui.settings.get('mineDensity'),
        };
        ui._pauseCategoryName = 'Custom';
        ui._pauseLevelName = 'Custom';

        // Try 'custom' slot first
        let save = null;
        if (ui.settings.hasSavedGameForCurrentSelection(gd)) {
            ui.settings.setCustomGame(true);
            save = ui.settings.loadGameStateForKey('custom');
        }
        // If no custom save, try the matching preset slot (custom dims match a known preset)
        if (!save && ui.settings.isKnownLevelPreset(gd) && ui.settings.hasSavedGameForLevel(gd)) {
            ui.settings.setCustomGame(false);
            const key = ui.settings.gridDataKey(gd);
            save = ui.settings.loadGameStateForKey(key);
        }
        if (!save) {
            ui._showToast('No saved game found for current custom settings');
            return;
        }

        // Update lastGameKey to this game
        ui.settings.saveGameState(save.grid, save.gridData, save.elapsedTimeMs, save.fogCache || [], save.fogCacheLimit);
        this._resumeFromSave(save);
    }

    _resumeFromSave(save) {
        const ui = this.ui;
        const variant = (ui._activeGameVariant && ui._activeGameVariant.length > 0)
            ? ui._activeGameVariant
            : 'normal';
        if (variant === 'normal') {
            if (save.isCustom) {
                ui._pauseCategoryName = 'Custom';
                ui._pauseLevelName = 'Custom';
            } else {
                ui._pauseCategoryName = ui.settings.getLevelCategory(save.gridData) || 'Custom';
                ui._pauseLevelName = ui.settings.getLevelShortName(save.gridData) || 'Custom';
            }
        } else {
            if (save.isCustom) {
                ui._pauseCategoryName = 'Custom';
                ui._pauseLevelName = 'Custom';
            } else {
                ui._pauseCategoryName = ui.settings.getGameModeLevelCategory(variant, save.gridData) || 'Custom';
                ui._pauseLevelName = ui.settings.getGameModeLevelShortName(variant, save.gridData) || 'Custom';
            }
        }
        ui.isInLobby = false;
        ui._duelResult = null;
        ui.modalState.resetDeathState();
        ui.gridManager.fogCacheLimit = save.fogCacheLimit || 20;
        ui.gridManager.loadGame(save.grid, save.gridData, save.fogCache || []);
        ui.timer.setFromDuration(save.elapsedTimeMs || 0);
        ui.timer.startTicking();
        ui._updateMinesDisplay(ui.gridManager.minesRemaining);
        ui._showScreen('gameView');
        ui.gridRenderer.centerGrid();
        document.getElementById('networkBar').classList.remove('visible');
        ui.gameModal.hideGameModal();
        ui.gameModal.syncPauseButton();
    }

    /** Start a server-rated (SoloLeaderboard) game. */
    startRatedGame(w, h, density, categoryName = '', levelName = '') {
        const ui = this.ui;
        const gridData = { w, h, density };
        ui._pauseCategoryName = categoryName || ui.settings.getLevelCategory(gridData) || 'Custom';
        ui._pauseLevelName = levelName || ui.settings.getLevelShortName(gridData) || 'Custom';
        ui.connection.ensureConnected(() => {
            const name = ui.settings.get('playerName') || 'Player';
            ui.lobbyHandler.hostGame(name, {
                gameType: GameType.SoloLeaderboard,
                grid: { w, h, density },
            }, LobbyVisibility.Private);
        });
    }

    // ========================================================================
    // Game mode methods
    // ========================================================================

    openGameMode(gameModeId) {
        this._selectedGameMode = gameModeId;
        this._gameModeExpandedCategory = 0;
        this.renderSoloMenu();
    }

    closeGameMode() {
        this._selectedGameMode = '';
        this.renderSoloMenu();
    }

    startGameModeLevel(gameModeId, w, h, density, visibleCells, l, categoryName = '', levelName = '') {
        const ui = this.ui;
        const gridData = { w, h, density, l: l || 0 };

        if (gameModeId === 'infinite_minesweeper') {
            const d = Math.max(15, Math.min(40, Number(density) || 20));
            const levelData = { density: d };
            ui._pauseCategoryName = categoryName || ui.settings.getGameModeLevelCategory(gameModeId, levelData) || 'Custom';
            ui._pauseLevelName = levelName || ui.settings.getGameModeLevelShortName(gameModeId, levelData) || 'Custom';
            ui._activeGameVariant = gameModeId;
            ui.gridManager.gameVariant = gameModeId;
            const isExplicitCustom = ui._pauseCategoryName === 'Custom' || ui._pauseLevelName === 'Custom';
            ui._launchInfiniteGame(d, !isExplicitCustom && ui.settings.isInfinitePresetDensity(d));
            return;
        }

        ui._pauseCategoryName = categoryName || ui.settings.getGameModeLevelCategory(gameModeId, gridData) || 'Custom';
        ui._pauseLevelName = levelName || ui.settings.getGameModeLevelShortName(gameModeId, gridData) || 'Custom';

        if (gameModeId === 'minesweeper_3d' && l > 0) {
            ui._launch3DGame(w, h, l, density);
            return;
        }
        // Set custom flag before launching so auto-saves use the right slot.
        const isCustomLevel = categoryName === 'Custom' || levelName === 'Custom';
        if (isCustomLevel) {
            ui.settings.setCustomGame(true);
            ui.settings.clearGameSave('custom');
        } else {
            ui.settings.setCustomGame(false);
        }
        ui.gridManager.fogCacheLimit = visibleCells || 20;
        this._launchLocalGame(w, h, density, ui._pauseCategoryName, ui._pauseLevelName);
        // Track that this was a game mode game (for save/progress)
        ui._activeGameVariant = gameModeId;
        ui.gridManager.gameVariant = gameModeId;
    }

    continueGameModeLevel(gameModeId, w, h, density, visibleCells, l) {
        const ui = this.ui;
        ui._isContinuedGame = true;
        ui._gamePlayedTracked = true;
        ui.actionHandler._gamePlayedTracked = true;
        const gridData = { w, h, density, l: l || 0 };

        if (gameModeId === 'infinite_minesweeper') {
            const d = Math.max(15, Math.min(40, Number(density) || 20));
            const levelData = { density: d };
            ui._pauseCategoryName = ui.settings.getGameModeLevelCategory(gameModeId, levelData) || 'Custom';
            ui._pauseLevelName = ui.settings.getGameModeLevelShortName(gameModeId, levelData) || 'Custom';
            const key = ui.settings.resolveInfiniteSaveKey(d, true);
            const result = ui.settings.loadInfiniteGameForKey(key);
            if (!result) { ui._showToast('No saved game found for this level'); return; }

            ui._activeGameVariant = gameModeId;
            ui.gridManager.gameVariant = gameModeId;
            ui._resumeInfiniteFromSave(result.saveData, result.elapsedTimeMs, key, true);
            return;
        }

        ui._pauseCategoryName = ui.settings.getGameModeLevelCategory(gameModeId, gridData) || 'Custom';
        ui._pauseLevelName = ui.settings.getGameModeLevelShortName(gameModeId, gridData) || 'Custom';

        if (gameModeId === 'minesweeper_3d') {
            const gd = { w, h, l: l || 0, density };
            const key = ui.settings.resolveGameModeSaveKey(gameModeId, gd);
            const result = ui.settings.loadGameModeState3DForKey(gameModeId, key);
            if (!result) { ui._showToast('No saved game found for this level'); return; }
            ui._activeGameVariant = gameModeId;
            ui.gridManager.gameVariant = gameModeId;
            ui._resume3DFromSave(result.grid3DState, result.elapsedTimeMs);
            return;
        }
        const gd = { w, h, density };
        const key = ui.settings.resolveGameModeSaveKey(gameModeId, gd);
        // Preset game mode continue: saves go back to the preset key.
        ui.settings.setCustomGame(false);
        const save = ui.settings.loadGameModeStateForKey(gameModeId, key);
        if (!save) { ui._showToast('No saved game found for this level'); return; }
        ui._activeGameVariant = gameModeId;
        ui.gridManager.gameVariant = gameModeId;
        this._resumeFromSave(save);
    }

    continueGameModeLastGame(gameModeId) {
        const ui = this.ui;
        ui._isContinuedGame = true;
        ui._gamePlayedTracked = true;
        ui.actionHandler._gamePlayedTracked = true;
        if (gameModeId === 'infinite_minesweeper') {
            const result = ui.settings.loadInfiniteLastGame();
            if (!result) { ui._showToast('No saved game found'); return; }

            ui._activeGameVariant = gameModeId;
            ui.gridManager.gameVariant = gameModeId;
            const density = Number(result.saveData?.density) || 20;
            const isPreset = ui.settings.isInfinitePresetDensity(density) && result.key !== 'custom';
            if (result.key === 'custom') {
                ui._pauseCategoryName = 'Custom';
                ui._pauseLevelName = 'Custom';
            } else {
                ui._pauseCategoryName = ui.settings.getGameModeLevelCategory(gameModeId, { density }) || 'Custom';
                ui._pauseLevelName = ui.settings.getGameModeLevelShortName(gameModeId, { density }) || 'Custom';
            }
            ui._resumeInfiniteFromSave(result.saveData, result.elapsedTimeMs, result.key || '', isPreset);
            return;
        }

        if (gameModeId === 'minesweeper_3d') {
            const result = ui.settings.loadGameModeLastGameState3D(gameModeId);
            if (!result) { ui._showToast('No saved game found'); return; }
            ui._activeGameVariant = gameModeId;
            ui.gridManager.gameVariant = gameModeId;
            if (result.key === 'custom') {
                ui._pauseCategoryName = 'Custom';
                ui._pauseLevelName = 'Custom';
            } else {
                const gridData = {
                    w: result.grid3DState.w,
                    h: result.grid3DState.h,
                    l: result.grid3DState.l,
                    density: result.grid3DState.density,
                };
                ui._pauseCategoryName = ui.settings.getGameModeLevelCategory(gameModeId, gridData) || 'Custom';
                ui._pauseLevelName = ui.settings.getGameModeLevelShortName(gameModeId, gridData) || 'Custom';
            }
            ui._resume3DFromSave(result.grid3DState, result.elapsedTimeMs);
            return;
        }
        const save = ui.settings.loadGameModeLastGameState(gameModeId);
        if (!save) { ui._showToast('No saved game found'); return; }
        // Restore custom flag from saved last-key so auto-saves go to the right slot.
        const lastKey = save.key || '';
        ui.settings.setCustomGame(lastKey === 'custom');
        ui._activeGameVariant = gameModeId;
        ui.gridManager.gameVariant = gameModeId;
        this._resumeFromSave(save);
    }

    // ========================================================================
    // Solo menu rendering
    // ========================================================================

    renderSoloMenu() {
        const ui = this.ui;
        const w  = ui.settings.get('gridWidth');
        const h  = ui.settings.get('gridHeight');
        const d  = ui.settings.get('mineDensity');
        const mines = Math.round(w * h * d / 100);

        document.getElementById('soloCustomSize').textContent    = `${w} × ${h}`;
        document.getElementById('soloCustomDensity').textContent = `Density: ${d}%`;
        document.getElementById('soloCustomMines').textContent   = `Mines: ${mines}`;

        // Custom continue button — show if a save exists in the custom slot,
        // OR if the custom settings match a known preset that has a save.
        const customContinueBtn = document.getElementById('btnCustomContinue');
        if (customContinueBtn) {
            const customGd = { w, h, density: d };
            const hasCustomSave = ui.settings.hasSavedGameForCurrentSelection(customGd)
                || (ui.settings.isKnownLevelPreset(customGd) && ui.settings.hasSavedGameForLevel(customGd));
            customContinueBtn.style.display = hasCustomSave ? '' : 'none';
        }

        this._ensureCustomPreview('customPreview', w, h, d);
        this._updateContinueCard();

        const container = document.getElementById('presetCategories');
        container.innerHTML = '';

        LEVEL_PRESETS.forEach((cat, catIdx) => {
            const expanded = this._expandedCategory === catIdx;

            const hdr = document.createElement('div');
            hdr.className = 'category-header' + (expanded ? ' expanded' : '');
            hdr.innerHTML = `<span class="category-arrow">${expanded ? '▼' : '▶'}</span>
                <span class="category-name">${cat.name}</span>
                <span class="category-count">(${cat.levels.length} levels)</span>`;
            hdr.onclick = () => {
                this._expandedCategory = expanded ? -1 : catIdx;
                this.renderSoloMenu();
            };
            container.appendChild(hdr);

            const wrap = document.createElement('div');
            wrap.className = 'category-levels' + (expanded ? ' expanded' : '');
            cat.levels.forEach(lv => {
                const card      = document.createElement('div');
                const mineCount = Math.round(lv.w * lv.h * lv.density / 100);
                const progress  = ui.settings.getLevelProgress(lv);
                const bestTime  = ui.settings.getLevelBestTime(lv);
                const hasSave   = ui.settings.hasSavedGameForLevel(lv);
                const bgColor   = progress >= 100 ? 'var(--card-level-done)'
                                : progress  >    0 ? 'var(--card-level-started)' : 'var(--card-level)';

                card.className = 'level-card level-card-preset';
                card.style.background = bgColor;

                const bestTimeHtml = (bestTime !== null && bestTime >= 0)
                    ? `<div class="level-best-time level-best-set">Best: ${ui._formatDuration(bestTime)}</div>`
                    : `<div class="level-best-time level-best-none">Best: —</div>`;

                let progressHtml = '';
                if (progress > 0) {
                    const barColor = progress >= 100 ? 'var(--progress-complete)' : 'var(--progress-partial)';
                    progressHtml = `<div class="progress-bar-container">
                        <div class="progress-bar-fill" style="width:${progress}%;background:${barColor}"></div>
                        <div class="progress-bar-text">${progress}%</div>
                    </div>`;
                }

                const continueHtml = hasSave ? '<button class="btn btn-icon btn-continue-preset">Continue</button>' : '';

                card.innerHTML = `<div class="level-card-body">
                    <div class="level-preview-container" id="preview-${catIdx}-${lv.name.replace(/\s/g, '')}"></div>
                    <div class="level-info">
                        <div class="level-name">${lv.name}</div>
                        <div class="level-detail">${lv.w} × ${lv.h}</div>
                        <div class="level-detail">Density: ${lv.density}%</div>
                        <div class="level-detail">Mines: ${mineCount}</div>
                        ${bestTimeHtml}
                        ${progressHtml}
                    </div>
                    <div class="level-actions">
                        <button class="btn btn-icon btn-play-preset">▶</button>
                        ${lv.rated ? '<button class="btn btn-icon btn-rated-preset">▶ Rated</button>' : ''}
                        ${continueHtml}
                    </div>
                </div>`;

                card.querySelector('.btn-play-preset').onclick = (e) => {
                    e.stopPropagation();
                    this.startSoloPresetGame(lv.w, lv.h, lv.density, cat.name, lv.name);
                };
                const continueBtn = card.querySelector('.btn-continue-preset');
                if (continueBtn) {
                    continueBtn.onclick = (e) => {
                        e.stopPropagation();
                        this.continueGameForLevel(lv.w, lv.h, lv.density);
                    };
                }
                const ratedBtn = card.querySelector('.btn-rated-preset');
                if (ratedBtn) {
                    ratedBtn.onclick = (e) => {
                        e.stopPropagation();
                        this.startRatedGame(lv.w, lv.h, lv.density, cat.name, lv.name);
                    };
                }
                wrap.appendChild(card);
            });
            container.appendChild(wrap);

            if (expanded) {
                cat.levels.forEach(lv => {
                    const id = `preview-${catIdx}-${lv.name.replace(/\s/g, '')}`;
                    const el = document.getElementById(id);
                    if (el) {
                        const hasSave = ui.settings.hasSavedGameForLevel(lv);
                        const grid = hasSave ? this._loadLevelPreviewGrid(lv) : null;
                        this._renderLevelPreviewCanvas(el, lv.w, lv.h, grid);
                    }
                });
            }
        });

        // Other game modes section
        this._renderOtherGameModes();
        this._renderGameModeLevelView();
    }

    _renderOtherGameModes() {
        const container = document.getElementById('otherGameModes');
        container.innerHTML = '';

        if (this._selectedGameMode || OTHER_GAME_MODES.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = '';

        const expanded = this._otherModesExpanded;

        const hdr = document.createElement('div');
        hdr.className = 'category-header' + (expanded ? ' expanded' : '');
        hdr.innerHTML = `<span class="category-arrow">${expanded ? '▼' : '▶'}</span>
            <span class="category-name">Other game modes</span>`;
        hdr.onclick = () => {
            this._otherModesExpanded = !this._otherModesExpanded;
            this._renderOtherGameModes();
        };
        container.appendChild(hdr);

        if (!expanded) return;

        const wrap = document.createElement('div');
        wrap.className = 'category-levels expanded';

        OTHER_GAME_MODES.forEach(mode => {
            let levelCount = 0;
            for (const cat of mode.categories) levelCount += cat.levels.length;

            const card = document.createElement('div');
            card.className = 'level-card game-mode-card';
            card.style.cursor = 'pointer';
            card.innerHTML = `<div class="level-card-body">
                <div class="level-info">
                    <div class="level-name">${mode.name}</div>
                    <div class="level-detail">${levelCount} levels</div>
                </div>
                <div class="level-actions">
                    <span style="color:#fff;font-size:16px">▶</span>
                </div>
            </div>`;
            card.onclick = () => this.openGameMode(mode.id);
            wrap.appendChild(card);
        });

        container.appendChild(wrap);
    }

    _renderGameModeLevelView() {
        const view = document.getElementById('gameModeLevelView');

        if (!this._selectedGameMode) {
            view.style.display = 'none';
            // Restore main solo menu elements
            document.querySelector('.custom-card').style.display = '';
            document.getElementById('presetCategories').style.display = '';
            this._updateContinueCard(); // let it decide its own visibility
            return;
        }

        // Hide main solo menu elements
        document.getElementById('continueCard').style.display = 'none';
        document.querySelector('.custom-card').style.display = 'none';
        document.getElementById('presetCategories').style.display = 'none';
        view.style.display = '';

        const ui = this.ui;
        const mode = OTHER_GAME_MODES.find(m => m.id === this._selectedGameMode);
        if (!mode) return;

        document.getElementById('gameModeLevelTitle').textContent = mode.name;
        document.getElementById('gameModeBackBtn').onclick = () => this.closeGameMode();

        const container = document.getElementById('gameModeLevelCategories');
        container.innerHTML = '';

        // Continue last game card for this mode
        const savedInfo = ui.settings.getGameModeSavedGameInfo(this._selectedGameMode);
        if (savedInfo.exists) {
            const card = document.createElement('div');
            card.className = 'level-card continue-card';
            card.style.cursor = 'pointer';
            const isInfiniteMode = this._selectedGameMode === 'infinite_minesweeper';
            const is3DMode = this._selectedGameMode === 'minesweeper_3d';
            const dimText = isInfiniteMode
                ? 'Endless grid'
                : ((savedInfo.l && savedInfo.l > 0) ? `${savedInfo.w} × ${savedInfo.h} × ${savedInfo.l}` : `${savedInfo.w} × ${savedInfo.h}`);
            const densityText = isInfiniteMode
                ? `Density: ${savedInfo.density}%`
                : `Density: ${savedInfo.density}% (${savedInfo.mineCount} mines)`;
            const scoreLine = isInfiniteMode
                ? `<div class="level-detail level-best-set">Current score: ${savedInfo.currentScore || 0}</div>`
                : '';
            const previewId = 'gm-continue-preview';
            card.innerHTML = `<div class="level-card-body">
                <div class="level-preview-container" id="${previewId}"></div>
                <div class="level-info">
                    <div class="level-name continue-title">Continue Last Game</div>
                    <div class="level-detail">${savedInfo.levelName || 'Custom level'}</div>
                    <div class="level-detail">${dimText}</div>
                    <div class="level-detail">${densityText}</div>
                    ${scoreLine}
                </div>
                <div class="level-actions">
                    <button class="btn btn-icon btn-play-gm-continue">▶</button>
                </div>
            </div>`;
            card.onclick = () => this.continueGameModeLastGame(this._selectedGameMode);
            card.querySelector('.btn-play-gm-continue').onclick = (e) => {
                e.stopPropagation();
                this.continueGameModeLastGame(this._selectedGameMode);
            };
            container.appendChild(card);

            // Render continue preview with saved game data
            requestAnimationFrame(() => {
                const el = document.getElementById(previewId);
                if (!el) return;
                if (!isInfiniteMode && !is3DMode) {
                    const save = ui.settings.loadGameModeLastGameState(this._selectedGameMode);
                    const previewGrid = save ? save.grid : null;
                    this._renderLevelPreviewCanvas(el, savedInfo.w, savedInfo.h, previewGrid);
                } else {
                    const previewW = isInfiniteMode ? 15 : savedInfo.w;
                    const previewH = isInfiniteMode ? 15 : savedInfo.h;
                    this._renderLevelPreviewCanvas(el, previewW, previewH);
                }
            });
        }

        // Custom level card (if mode supports it)
        if (mode.customEnabled) {
            this._renderGameModeCustomCard(container, mode);
        }

        mode.categories.forEach((cat, catIdx) => {
            const expanded = this._gameModeExpandedCategory === catIdx;

            const hdr = document.createElement('div');
            hdr.className = 'category-header' + (expanded ? ' expanded' : '');
            hdr.innerHTML = `<span class="category-arrow">${expanded ? '▼' : '▶'}</span>
                <span class="category-name">${cat.name}</span>
                <span class="category-count">(${cat.levels.length} levels)</span>`;
            hdr.onclick = () => {
                this._gameModeExpandedCategory = expanded ? -1 : catIdx;
                this._renderGameModeLevelView();
            };
            container.appendChild(hdr);

            const wrap = document.createElement('div');
            wrap.className = 'category-levels' + (expanded ? ' expanded' : '');

            cat.levels.forEach(lv => {
                const card = document.createElement('div');
                const isInfinite = this._selectedGameMode === 'infinite_minesweeper';
                const is3D = this._selectedGameMode === 'minesweeper_3d' && lv.l > 0;
                const mineCount = is3D
                    ? Math.round(2 * (lv.w * lv.h + lv.w * lv.l + lv.h * lv.l) * lv.density / 100)
                    : Math.round((lv.w || 0) * (lv.h || 0) * lv.density / 100);
                const progress = isInfinite ? 0 : ui.settings.getGameModeProgress(this._selectedGameMode, lv);
                const bestTime = isInfinite ? null : ui.settings.getGameModeBestTime(this._selectedGameMode, lv);

                const infiniteSaveKey = isInfinite ? ui.settings.resolveInfiniteSaveKey(lv.density, true) : '';
                const infiniteSaveInfo = isInfinite ? ui.settings.getInfiniteSavedGameInfoForKey(infiniteSaveKey) : null;
                const hasSave = isInfinite ? !!(infiniteSaveInfo && infiniteSaveInfo.exists) : ui.settings.hasGameModeSavedGame(this._selectedGameMode, lv);

                const bgColor = isInfinite
                    ? (hasSave ? 'var(--card-level-started)' : 'var(--card-level)')
                    : (progress >= 100 ? 'var(--card-level-done)'
                        : progress > 0 ? 'var(--card-level-started)' : 'var(--card-level)');

                card.className = 'level-card level-card-preset';
                card.style.background = bgColor;

                const bestTimeHtml = (bestTime !== null && bestTime >= 0)
                    ? `<div class="level-best-time level-best-set">Best: ${ui._formatDuration(bestTime)}</div>`
                    : `<div class="level-best-time level-best-none">Best: —</div>`;

                const infiniteScore = isInfinite ? ui.settings.getInfinitePresetScoreInfo(lv.density) : null;
                const infiniteStatsHtml = isInfinite
                    ? [
                        `<div class="level-detail">Last score: ${(infiniteScore && infiniteScore.lastScore) || 0}</div>`,
                        `<div class="level-detail level-best-set">High score: ${(infiniteScore && infiniteScore.highScore) || 0}</div>`,
                        hasSave ? `<div class="level-detail">Current score: ${(infiniteSaveInfo && infiniteSaveInfo.currentScore) || 0}</div>` : '',
                    ].join('')
                    : '';

                let progressHtml = '';
                if (!isInfinite && progress > 0) {
                    const barColor = progress >= 100 ? 'var(--progress-complete)' : 'var(--progress-partial)';
                    progressHtml = `<div class="progress-bar-container">
                        <div class="progress-bar-fill" style="width:${progress}%;background:${barColor}"></div>
                        <div class="progress-bar-text">${progress}%</div>
                    </div>`;
                }

                const continueHtml = hasSave ? '<button class="btn btn-icon btn-continue-gm">Continue</button>' : '';
                const previewId = `gm-preview-${catIdx}-${lv.name.replace(/\s/g, '')}`;
                const dimText = isInfinite ? 'Endless grid' : (is3D ? `${lv.w} × ${lv.h} × ${lv.l}` : `${lv.w} × ${lv.h}`);
                const visibleLine = (lv.visibleCells && !is3D) ? `<div class="level-detail">Visible cells: ${lv.visibleCells || 20}</div>` : '';
                const minesLine = isInfinite ? '' : `<div class="level-detail">Mines: ${mineCount}</div>`;
                const bestLine = isInfinite ? '' : bestTimeHtml;

                card.innerHTML = `<div class="level-card-body">
                    <div class="level-preview-container" id="${previewId}"></div>
                    <div class="level-info">
                        <div class="level-name">${lv.name}</div>
                        <div class="level-detail">${dimText}</div>
                        <div class="level-detail">Density: ${lv.density}%</div>
                        ${minesLine}
                        ${visibleLine}
                        ${bestLine}
                        ${infiniteStatsHtml}
                        ${progressHtml}
                    </div>
                    <div class="level-actions">
                        <button class="btn btn-icon btn-play-gm">▶</button>
                        ${continueHtml}
                    </div>
                </div>`;

                card.querySelector('.btn-play-gm').onclick = (e) => {
                    e.stopPropagation();
                    this.startGameModeLevel(this._selectedGameMode, lv.w, lv.h, lv.density, lv.visibleCells, lv.l, cat.name, lv.name);
                };
                const continueBtn = card.querySelector('.btn-continue-gm');
                if (continueBtn) {
                    continueBtn.onclick = (e) => {
                        e.stopPropagation();
                        this.continueGameModeLevel(this._selectedGameMode, lv.w, lv.h, lv.density, lv.visibleCells, lv.l);
                    };
                }
                wrap.appendChild(card);
            });
            container.appendChild(wrap);

            if (expanded) {
                cat.levels.forEach(lv => {
                    const id = `gm-preview-${catIdx}-${lv.name.replace(/\s/g, '')}`;
                    const el = document.getElementById(id);
                    if (el) {
                        const previewW = this._selectedGameMode === 'infinite_minesweeper' ? 15 : lv.w;
                        const previewH = this._selectedGameMode === 'infinite_minesweeper' ? 15 : lv.h;
                        const is3D = this._selectedGameMode === 'minesweeper_3d';
                        const isInfinite = this._selectedGameMode === 'infinite_minesweeper';
                        let grid = null;
                        if (!is3D && !isInfinite) {
                            const hasSave = ui.settings.hasGameModeSavedGame(this._selectedGameMode, lv);
                            grid = hasSave ? this._loadGameModeLevelPreviewGrid(this._selectedGameMode, lv) : null;
                        }
                        this._renderLevelPreviewCanvas(el, previewW, previewH, grid);
                    }
                });
            }
        });
    }

    _getGameModeCustomSettings(gameModeId) {
        const saved = this.ui.settings.loadGameModeCustomSettings(gameModeId);
        if (saved && (saved.w || gameModeId === 'infinite_minesweeper')) return saved;
        // Defaults
        if (gameModeId === 'infinite_minesweeper')
            return { w: 15, h: 15, l: 5, d: 20, visibleCells: 10 };
        if (gameModeId === 'minesweeper_3d')
            return { w: 5, h: 5, l: 5, d: 20, visibleCells: 10 };
        return { w: 10, h: 10, l: 5, d: 20, visibleCells: 10 };
    }

    _renderGameModeCustomCard(container, mode) {
        const ui = this.ui;
        const gameModeId = mode.id;
        const s = this._getGameModeCustomSettings(gameModeId);
        const is3D = gameModeId === 'minesweeper_3d';
        const isFoW = gameModeId === 'fog_of_war';
        const isInfinite = gameModeId === 'infinite_minesweeper';
        const hasInfiniteCustomSave = isInfinite && ui.settings.hasInfiniteSavedCustomGame();

        const mineCount = is3D
            ? Math.round(2 * (s.w * s.h + s.w * s.l + s.h * s.l) * s.d / 100)
            : Math.round(s.w * s.h * s.d / 100);
        const dimText = isInfinite ? 'Endless grid' : (is3D ? `${s.w} × ${s.h} × ${s.l}` : `${s.w} × ${s.h}`);
        const visibleLine = isFoW ? `<div class="level-detail">Visible cells: ${s.visibleCells}</div>` : '';
        const minesLine = isInfinite
            ? '<div class="level-detail">Score: Revealed safe cells</div>'
            : `<div class="level-detail">Mines: ${mineCount}</div>`;

        const card = document.createElement('div');
        card.className = 'level-card';
        card.style.background = 'var(--card-primary, #1e3a2e)';

        const previewId = 'gm-custom-preview';
        card.innerHTML = `<div class="level-card-body">
            <div class="level-preview-container" id="${previewId}"></div>
            <div class="level-info">
                <div class="level-name">Custom</div>
                <div class="level-detail">${dimText}</div>
                <div class="level-detail">Density: ${s.d}%</div>
                ${minesLine}
                ${visibleLine}
            </div>
            <div class="level-actions">
                <button class="btn btn-icon btn-gm-custom-play">▶</button>
                <button class="btn btn-icon btn-gm-custom-settings">Settings</button>
                ${hasInfiniteCustomSave ? '<button class="btn btn-icon btn-gm-custom-continue">Continue</button>' : ''}
            </div>
        </div>`;

        card.querySelector('.btn-gm-custom-play').onclick = (e) => {
            e.stopPropagation();
            this.startGameModeLevel(gameModeId, s.w, s.h, s.d, s.visibleCells, s.l || 0, 'Custom', 'Custom');
        };
        card.querySelector('.btn-gm-custom-settings').onclick = (e) => {
            e.stopPropagation();
            this._openGameModeCustomSettings(gameModeId);
        };
        const continueBtn = card.querySelector('.btn-gm-custom-continue');
        if (continueBtn) {
            continueBtn.onclick = (e) => {
                e.stopPropagation();
                const result = ui.settings.loadInfiniteGameForKey('custom');
                if (!result) { ui._showToast('No saved custom game found'); return; }
                ui._activeGameVariant = gameModeId;
                ui.gridManager.gameVariant = gameModeId;
                ui._pauseCategoryName = 'Custom';
                ui._pauseLevelName = 'Custom';
                ui._resumeInfiniteFromSave(result.saveData, result.elapsedTimeMs, 'custom', false);
            };
        }

        container.appendChild(card);

        requestAnimationFrame(() => {
            const el = document.getElementById(previewId);
            if (!el) return;
            const previewW = isInfinite ? 15 : s.w;
            const previewH = isInfinite ? 15 : s.h;
            // Try to load saved grid for the custom game mode preview
            let grid = null;
            if (!is3D && !isInfinite) {
                const gd = { w: s.w, h: s.h, density: s.d };
                if (ui.settings.hasGameModeSavedGame(gameModeId, gd)) {
                    grid = this._loadGameModeLevelPreviewGrid(gameModeId, gd);
                }
            }
            this._renderLevelPreviewCanvas(el, previewW, previewH, grid);
        });
    }

    _openGameModeCustomSettings(gameModeId) {
        const s = this._getGameModeCustomSettings(gameModeId);
        const is3D = gameModeId === 'minesweeper_3d';
        const isFoW = gameModeId === 'fog_of_war';
        const isInfinite = gameModeId === 'infinite_minesweeper';

        const minWH = is3D ? 2 : 5;
        const maxWHL = is3D ? 32 : 128;
        document.getElementById('gmCustomWLabel').textContent = `Width (${minWH}–${maxWHL})`;
        document.getElementById('gmCustomHLabel').textContent = `Height (${minWH}–${maxWHL})`;
        document.getElementById('gmCustomW').min = minWH;
        document.getElementById('gmCustomH').min = minWH;
        document.getElementById('gmCustomW').max = maxWHL;
        document.getElementById('gmCustomH').max = maxWHL;
        document.getElementById('gmCustomL').max = maxWHL;
        document.getElementById('gmCustomW').value = s.w;
        document.getElementById('gmCustomH').value = s.h;
        document.getElementById('gmCustomL').value = s.l || 5;
        document.getElementById('gmCustomD').value = s.d;
        document.getElementById('gmCustomD').min = isInfinite ? 15 : 5;
        document.getElementById('gmCustomDLabel').textContent = `Mine Density: ${s.d}%`;

        document.getElementById('gmCustomWRow').style.display = isInfinite ? 'none' : '';
        document.getElementById('gmCustomHRow').style.display = isInfinite ? 'none' : '';
        document.getElementById('gmCustomLRow').style.display = is3D ? '' : 'none';
        document.getElementById('gmCustomVCRow').style.display = isFoW ? '' : 'none';
        if (isFoW) {
            document.getElementById('gmCustomVC').value = s.visibleCells || 10;
            document.getElementById('gmCustomVC').max = s.w * s.h;
            document.getElementById('gmCustomVCLabel').textContent = `Visible Cells (1–${s.w * s.h})`;
        }

        // Wire density label update
        const slider = document.getElementById('gmCustomD');
        slider.oninput = () => {
            document.getElementById('gmCustomDLabel').textContent = `Mine Density: ${slider.value}%`;
            if (isFoW) {
                const maxVC = parseInt(document.getElementById('gmCustomW').value) * parseInt(document.getElementById('gmCustomH').value);
                document.getElementById('gmCustomVC').max = maxVC;
                document.getElementById('gmCustomVCLabel').textContent = `Visible Cells (1–${maxVC})`;
            }
        };

        // Wire W/H change to update VC max for FoW
        if (isFoW) {
            const wInput = document.getElementById('gmCustomW');
            const hInput = document.getElementById('gmCustomH');
            const updateVCMax = () => {
                const maxVC = parseInt(wInput.value) * parseInt(hInput.value);
                document.getElementById('gmCustomVC').max = maxVC;
                document.getElementById('gmCustomVCLabel').textContent = `Visible Cells (1–${maxVC})`;
            };
            wInput.oninput = updateVCMax;
            hInput.oninput = updateVCMax;
        }

        // Wire apply
        document.getElementById('gmCustomApplyBtn').onclick = () => {
            const minWH2 = is3D ? 2 : 5;
            const maxWHL2 = is3D ? 32 : 128;
            const w = Math.max(minWH2, Math.min(maxWHL2, parseInt(document.getElementById('gmCustomW').value) || minWH2));
            const h = Math.max(minWH2, Math.min(maxWHL2, parseInt(document.getElementById('gmCustomH').value) || minWH2));
            const l = Math.max(2, Math.min(maxWHL2, parseInt(document.getElementById('gmCustomL').value) || 3));
            const d = Math.max(isInfinite ? 15 : 5, Math.min(40, parseInt(document.getElementById('gmCustomD').value) || 20));
            const vc = Math.max(1, Math.min(w * h, parseInt(document.getElementById('gmCustomVC').value) || 15));

            const settings = isInfinite
                ? { w: 15, h: 15, l: 5, d, visibleCells: 10 }
                : { w, h, l, d, visibleCells: vc };
            this.ui.settings.saveGameModeCustomSettings(gameModeId, settings);
            this.ui._hideModal('gmCustomSettingsDialog');
            this._renderGameModeLevelView();
        };

        this.ui._showModal('gmCustomSettingsDialog');
    }

    _ensureLevelPreview(containerId, gridW, gridH) {
        const container = document.getElementById(containerId);
        if (!container) return;
        this._renderLevelPreviewCanvas(container, gridW, gridH);
    }

    /**
     * Render the custom card preview, loading saved grid data from whichever
     * slot has it: the 'custom' slot first, then the preset slot if the
     * custom settings happen to match a known preset.
     */
    _ensureCustomPreview(containerId, gridW, gridH, density) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const gd = { w: gridW, h: gridH, density };
        let grid = null;
        // Try the custom slot first
        if (this.ui.settings.hasSavedGameForCurrentSelection(gd)) {
            const save = this.ui.settings.loadGameStateForKey('custom');
            if (save) grid = save.grid;
        }
        // If no custom save, try the preset slot (custom settings might match a preset)
        if (!grid && this.ui.settings.isKnownLevelPreset(gd)) {
            grid = this._loadLevelPreviewGrid(gd);
        }
        this._renderLevelPreviewCanvas(container, gridW, gridH, grid);
    }

    _updateContinueCard() {
        const ui   = this.ui;
        const info = ui.settings.getSavedGameInfo();
        const card = document.getElementById('continueCard');
        if (!info.exists) { card.style.display = 'none'; return; }
        card.style.display = '';

        const nameEl = document.getElementById('continueLevelName');
        nameEl.textContent = info.levelName || 'Custom level';
        document.getElementById('continueSize').textContent    = `${info.w} × ${info.h}`;
        document.getElementById('continueDensity').textContent = `Density: ${info.density}% (${info.mineCount} mines)`;
        document.getElementById('continueTime').textContent    = `Time: ${ui.timer.formatTime(info.elapsedTimeMs || 0)}`;

        const savedGame       = ui.settings.loadLastGameState();
        const previewContainer = document.getElementById('continuePreview');
        if (previewContainer) {
            this._renderLevelPreviewCanvas(previewContainer, info.w, info.h, savedGame ? savedGame.grid : null);
        }
    }

    /**
     * Draw a small thumbnail of a grid level.
     * @param {HTMLElement} container
     * @param {number} gridW
     * @param {number} gridH
     * @param {Array<Array<{content,state}>>} [grid] - optional actual cell states
     */
    _renderLevelPreviewCanvas(container, gridW, gridH, grid) {
        container.innerHTML = '';
        const size   = Math.min(container.clientWidth || 150, container.clientHeight || 150);
        const dpr    = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.className = 'level-preview-canvas';
        canvas.width  = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
        canvas.style.width  = size + 'px';
        canvas.style.height = size + 'px';
        container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#333333';
        ctx.fillRect(0, 0, size, size);
        if (gridW === 0 || gridH === 0) return;

        // Compute adjacent mine counts if we have a real grid
        let adjGrid = null;
        if (grid) {
            adjGrid = [];
            for (let r = 0; r < gridH; r++) {
                adjGrid[r] = [];
                for (let c = 0; c < gridW; c++) {
                    let count = 0;
                    const yLo = r > 0 ? r - 1 : 0;
                    const yHi = r < gridH - 1 ? r + 1 : gridH - 1;
                    const xLo = c > 0 ? c - 1 : 0;
                    const xHi = c < gridW - 1 ? c + 1 : gridW - 1;
                    for (let ny = yLo; ny <= yHi; ny++) {
                        for (let nx = xLo; nx <= xHi; nx++) {
                            if (grid[ny] && grid[ny][nx] && grid[ny][nx].content === 2) count++;
                        }
                    }
                    adjGrid[r][c] = count;
                }
            }
        }

        const NUMBER_COLORS = ['#0000FF', '#008000', '#FF0000', '#000080', '#800000', '#008080', '#000000', '#808080'];
        const bordersVisible = gridW <= 50 && gridH <= 50;
        const gap = bordersVisible ? 0.5 : 0;
        const cellSize = Math.min((size - (gridW - 1) * gap) / gridW,
                                  (size - (gridH - 1) * gap) / gridH);
        const totalW = gridW * (cellSize + gap) - gap;
        const totalH = gridH * (cellSize + gap) - gap;
        const offX   = (size - totalW) / 2;
        const offY   = (size - totalH) / 2;

        // Set up font once if cells are large enough to show numbers
        const showNumbers = grid && cellSize >= 6;
        if (showNumbers) {
            const fs = Math.max(4, Math.floor(cellSize * 0.7));
            ctx.font = `700 ${fs}px "Segoe UI", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
        }

        for (let row = 0; row < gridH; row++) {
            for (let col = 0; col < gridW; col++) {
                const x = offX + col * (cellSize + gap);
                const y = offY + row * (cellSize + gap);

                if (grid && grid[row] && grid[row][col]) {
                    const cell = grid[row][col];
                    if (cell.state === CellState.Revealed) {
                        ctx.fillStyle = '#BBBBBB';
                        ctx.fillRect(x, y, cellSize, cellSize);
                        // Draw number
                        if (showNumbers && adjGrid && cell.content !== 2) {
                            const adj = adjGrid[row][col];
                            if (adj > 0 && adj <= 8) {
                                ctx.fillStyle = NUMBER_COLORS[adj - 1];
                                ctx.fillText(String(adj), x + cellSize / 2, y + cellSize * 0.54);
                            }
                        }
                        // Draw mine (shouldn't normally appear in preview, but handle it)
                        if (cell.content === 2 && cellSize >= 6) {
                            ctx.fillStyle = '#000000';
                            const r = cellSize * 0.25;
                            ctx.beginPath();
                            ctx.arc(x + cellSize / 2, y + cellSize / 2, r, 0, Math.PI * 2);
                            ctx.fill();
                        }
                    } else if (cell.state === CellState.Flagged) {
                        ctx.fillStyle = '#888888';
                        ctx.fillRect(x, y, cellSize, cellSize);
                        // Draw flag marker
                        if (cellSize >= 6) {
                            // Flag pole
                            const poleX = x + cellSize * 0.45;
                            ctx.strokeStyle = '#333333';
                            ctx.lineWidth = Math.max(1, cellSize * 0.08);
                            ctx.beginPath();
                            ctx.moveTo(poleX, y + cellSize * 0.2);
                            ctx.lineTo(poleX, y + cellSize * 0.8);
                            ctx.stroke();
                            // Flag triangle
                            ctx.fillStyle = '#FF3333';
                            ctx.beginPath();
                            ctx.moveTo(poleX, y + cellSize * 0.2);
                            ctx.lineTo(poleX + cellSize * 0.35, y + cellSize * 0.35);
                            ctx.lineTo(poleX, y + cellSize * 0.5);
                            ctx.closePath();
                            ctx.fill();
                        } else {
                            // Too small for flag detail, just color it
                            ctx.fillStyle = '#FFAA00';
                            ctx.fillRect(x, y, cellSize, cellSize);
                        }
                    } else {
                        ctx.fillStyle = '#888888';
                        ctx.fillRect(x, y, cellSize, cellSize);
                    }
                } else {
                    ctx.fillStyle = '#888888';
                    ctx.fillRect(x, y, cellSize, cellSize);
                }

                if (bordersVisible) {
                    ctx.strokeStyle = '#a3a3a3';
                    ctx.lineWidth   = 0.5;
                    ctx.strokeRect(x + 0.25, y + 0.25, cellSize - 0.5, cellSize - 0.5);
                }
            }
        }
    }

    /**
     * Load saved grid data for a normal level.
     * @returns {Array<Array<{content,state}>>|null}
     */
    _loadLevelPreviewGrid(gridData) {
        const key = this.ui.settings.gridDataKey(gridData);
        const save = this.ui.settings.loadGameStateForKey(key);
        return save ? save.grid : null;
    }

    /**
     * Load saved grid data for a game mode level.
     * @returns {Array<Array<{content,state}>>|null}
     */
    _loadGameModeLevelPreviewGrid(gameModeId, gridData) {
        const key = this.ui.settings.resolveGameModeSaveKey(gameModeId, gridData);
        const save = this.ui.settings.loadGameModeStateForKey(gameModeId, key);
        return save ? save.grid : null;
    }
}
