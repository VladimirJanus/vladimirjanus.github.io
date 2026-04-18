// LobbyUIManager.js — WAN lobby, public lobby browser, online hosting/joining
// ============================================================================

import { GameType, LobbyVisibility, NetworkRole, PlayerState } from '../../core/CoreEnums.js';
import { getPlayerColorHex } from '../../core/CoreTypes.js';

const PAGE_SIZE = 10;

export class LobbyUIManager {
    constructor(ui) {
        this.ui      = ui;
        this._pubPage = 0;
        this._showPlayerLobbies = true;
        this._showCommunity     = true;
        this._filterCoOpSoft    = false;
        this._filterCoOpHard    = false;
        this._filterPVPDuel     = false;
        this._communityLobbies  = [];
        this._playerLobbies     = [];
        this._currentQueryType  = -1;  // which query type the last request was for
        this._respawnTickId = 0;
        this._pubCooldownTickId = 0;
    }

    // ========================================================================
    // Dialog launchers
    // ========================================================================

    showHostDialog() {
        const ui = this.ui;
        ui.connection.ensureConnected(() => {
            ui._showModal('hostDialog');
            document.getElementById('hostPlayerName').value = ui.settings.get('playerName');
        });
    }

    showJoinDialog() {
        const ui = this.ui;
        ui.connection.ensureConnected(() => {
            ui._showModal('joinDialog');
            document.getElementById('joinPlayerName').value = ui.settings.get('playerName');
        });
    }

    showPublicLobbiesDialog(queryType = 0) {
        this.showGameBrowserDialog(queryType === 1 ? 1 : 0);
    }

    showGameBrowserDialog(initialTab = 0) {
        const ui = this.ui;
        ui.connection.ensureConnected(() => {
            this._pubPage = 0;
            this._showPlayerLobbies = true;
            this._showCommunity     = true;
            this._filterCoOpSoft    = false;
            this._filterCoOpHard    = false;
            this._filterPVPDuel     = false;
            this._communityLobbies  = [];
            this._playerLobbies     = [];

            ui._showScreen('gameBrowserScreen');
            this._setupBrowserButtons();
            this._doRequest();
        });
    }

    _setupBrowserButtons() {
        const tabPL  = document.getElementById('browserTabPlayerLobbies');
        const tabCom = document.getElementById('browserTabCommunity');
        const filterSection = document.getElementById('browserFilters');

        if (tabPL)  tabPL.classList.toggle('active', this._showPlayerLobbies);
        if (tabCom) tabCom.classList.toggle('active', this._showCommunity);
        if (filterSection) filterSection.style.display = this._showPlayerLobbies ? '' : 'none';

        [['browserFilterCoOpSoft', '_filterCoOpSoft'],
         ['browserFilterCoOpHard', '_filterCoOpHard'],
         ['browserFilterPVP',      '_filterPVPDuel']].forEach(([id, prop]) => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.toggle('active', this[prop]);
        });

        if (tabPL) tabPL.onclick = () => {
            this._showPlayerLobbies = !this._showPlayerLobbies;
            if (!this._showPlayerLobbies) {
                this._filterCoOpSoft = false;
                this._filterCoOpHard = false;
                this._filterPVPDuel  = false;
            }
            this._pubPage = 0;
            this._setupBrowserButtons();
            this._doRequest();
        };
        if (tabCom) tabCom.onclick = () => {
            this._showCommunity = !this._showCommunity;
            this._pubPage = 0;
            this._setupBrowserButtons();
            this._doRequest();
        };

        [['browserFilterCoOpSoft', '_filterCoOpSoft'],
         ['browserFilterCoOpHard', '_filterCoOpHard'],
         ['browserFilterPVP',      '_filterPVPDuel']].forEach(([id, prop]) => {
            const btn = document.getElementById(id);
            if (btn) btn.onclick = () => {
                this[prop] = !this[prop];
                this._setupBrowserButtons();
                this._renderFromSnapshots();
            };
        });
    }

    /**
     * Issues one or two server requests depending on selected categories.
     * When both are selected, community fires first; its callback chains the
     * player-lobbies request. Each response is stored in its own snapshot.
     */
    _doRequest() {
        const ui = this.ui;
        this._communityLobbies = [];
        this._playerLobbies    = [];

        if (!this._showPlayerLobbies && !this._showCommunity) {
            this._renderFromSnapshots();
            return;
        }

        if (this._showCommunity) {
            // Fire community first; if player lobbies also needed, the callback will chain it
            this._currentQueryType = 1;
            ui.queryHandler.requestPublicLobbies(1, this._pubPage, PAGE_SIZE);
        } else {
            // Only player lobbies
            this._currentQueryType = 0;
            ui.queryHandler.requestPublicLobbies(0, this._pubPage, PAGE_SIZE);
        }
    }

    // ========================================================================
    // Dialog confirm handlers (called from HTML via app.handleHostConfirm etc.)
    // ========================================================================

    handleHostConfirm() {
        const ui   = this.ui;
        const name = document.getElementById('hostPlayerName').value.trim();
        if (!name) { ui._showToast('Enter a player name'); return; }
        ui.settings.set('playerName', name);

        const saved = ui.settings.loadOnlineGameSettings();
        const w    = saved ? saved.gameData.grid.w       : ui.settings.get('gridWidth');
        const h    = saved ? saved.gameData.grid.h       : ui.settings.get('gridHeight');
        const d    = saved ? saved.gameData.grid.density : ui.settings.get('mineDensity');
        const gt   = saved ? saved.gameData.gameType     : GameType.CoOpHard;
        const vis  = saved ? saved.visibility            : LobbyVisibility.Private;

        ui.lobbyHandler.hostGame(name, { gameType: gt, grid: { w, h, density: d } }, vis);
        ui._hideModal('hostDialog');
    }

    handleJoinConfirm() {
        const ui    = this.ui;
        const name  = document.getElementById('joinPlayerName').value.trim();
        const idStr = document.getElementById('joinGameID').value.trim();
        if (!name)  { ui._showToast('Enter a player name'); return; }
        if (!idStr) { ui._showToast('Enter a Game ID');     return; }
        ui.settings.set('playerName', name);

        const gameID = parseInt(idStr);
        if (isNaN(gameID) || gameID <= 0) { ui._showToast('Invalid Game ID'); return; }

        const cooldown = ui.settings.getRespawnCooldown(gameID);
        const now = Date.now();
        if (cooldown > now) {
            const remaining = cooldown - now;
            const hours = Math.floor(remaining / 3600000);
            const mins = Math.floor((remaining % 3600000) / 60000);
            const secs = Math.floor((remaining % 60000) / 1000);
            ui._showToast(`You are still on cooldown for this game. Try again in ${hours}h ${mins}m ${secs}s.`);
            return;
        }

        ui.lobbyHandler.joinGame(name, gameID);
        ui._hideModal('joinDialog');
    }

    // ========================================================================
    // Lobby state actions
    // ========================================================================

    lobbyStartOrReady() {
        this.ui.handleLobbyStartAction();
    }

    lobbyLeave() { this.ui.lobbyHandler.leaveLobby(); }

    returnToGame() {
        const lh = this.ui.lobbyHandler;
        if (lh.role === NetworkRole.None) return;
        if (!lh.hasActiveGame) return;
        this.ui._showScreen('gameView');
    }

    /** True when the server has an active game round in progress. */
    serverGameActive() {
        const lh = this.ui.lobbyHandler;
        return lh.hasActiveGame || lh.serverGameActive;
    }

    // ========================================================================
    // Lobby rendering
    // ========================================================================

    renderLobby() {
        const ui     = this.ui;
        const lh     = ui.lobbyHandler;
        const isHost = lh.role === NetworkRole.Host;
        const isPVP  = lh.gameData.gameType === GameType.PVPDuel;
        const isSolo = lh.gameData.gameType === GameType.SoloLeaderboard;
        const isAllReady = ui.modalState.showReadyIndicators;

        // Title
        document.getElementById('lobbyTitle').textContent =
            isSolo ? 'Rated solo game' : isHost ? '🌍 Lobby (Host)' : '🌍 Lobby';

        // Game ID
        const gidEl = document.getElementById('lobbyGameID');
        gidEl.textContent = 'Game ID: ' + lh.lobbyID;
        gidEl.style.display = isSolo ? 'none' : '';

        // Config
        const grid = lh.gameData.grid;
        document.getElementById('lobbyConfig').textContent = `${grid.w}×${grid.h} Grid • ${grid.density}% Mines`;

        // Hint
        const hint = document.getElementById('lobbyHint');
        if (isSolo) {
            hint.textContent  = 'Start and win the game to be placed on the leaderboard!';
            hint.style.fontWeight = '';
        } else if (isHost) {
            hint.textContent  = 'Share this Game ID with players';
            hint.style.fontWeight = '';
        } else if (!lh.hasActiveGame && this.serverGameActive()) {
            hint.textContent  = "Game in progress — click 'Join Game in Progress' to participate";
            hint.style.fontWeight = 'bold';
        } else {
            hint.textContent  = 'Waiting for host to start…';
            hint.style.fontWeight = '';
        }

        // Header controls
        document.getElementById('btnLobbySettings').style.display     = (isHost && !isSolo) ? '' : 'none';

        // Player list
        const plEl = document.getElementById('playerList');
        plEl.innerHTML = '';
        lh.players.forEach((p, idx) => {
            const card   = document.createElement('div');
            card.className = 'player-card';
            const color  = getPlayerColorHex(p.inGameID, lh.gameData.gameType);
            card.style.background = color;

            const isCoOpSoft  = lh.gameData.gameType === GameType.CoOpSoft;
            const isCommunity = lh.gameData.gameType === GameType.Community;
            const showState   = isCoOpSoft || isPVP || isCommunity;
            const stateEmoji  = showState
                ? (p.state === PlayerState.Alive ? '💚' : p.state === PlayerState.Dead ? '💀' : '👁️')
                : '';
            const icon        = p.inGameID === 1 ? '👑' : '👤';
            const youTag      = p.inGameID === lh.ownPlayerID ? ' (You)' : '';
            const hostTag     = p.inGameID === 1
                ? '<span style="font-size:12px;font-weight:bold;color:#000;">HOST</span>' : '';

            let readyIndicator = '';
            if (isAllReady) {
                const rc  = p.isReady ? 'var(--ready-active)' : 'var(--bg-networkbar)';
                const bc  = p.isReady ? 'var(--ready-active)' : 'var(--ready-inactive)';
                const sym = p.isReady ? '✓' : '○';
                readyIndicator = `<span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:3px;background:${rc};border:1px solid ${bc};font-size:12px;font-weight:${p.isReady ? 'bold' : 'normal'};color:${p.isReady ? '#fff' : 'var(--text-muted)'}">${sym}</span>`;
            }

            const kickBtn = (isHost && p.inGameID !== lh.ownPlayerID)
                ? `<button class="btn btn-small btn-danger kick-btn" data-id="${p.inGameID}" style="width:auto">❌</button>` : '';

            card.innerHTML = `
                <span style="font-size:20px">${icon}</span>
                <span class="player-name" style="${p.inGameID === lh.ownPlayerID ? 'text-decoration:underline;' : ''}">${p.playerName}${youTag}</span>
                <span style="font-size:16px">${stateEmoji}</span>
                ${readyIndicator} ${hostTag} ${kickBtn}
            `;
            plEl.appendChild(card);
        });
        plEl.querySelectorAll('.kick-btn').forEach(btn => {
            btn.onclick = () => lh.kickPlayer(parseInt(btn.dataset.id));
        });

        // Pending players
        const pendSec = document.getElementById('pendingSection');
        pendSec.style.display = (isHost && lh.pendingPlayers.length > 0) ? '' : 'none';
        const pendEl  = document.getElementById('pendingList');
        pendEl.innerHTML = '';
        for (const p of lh.pendingPlayers) {
            const card = document.createElement('div');
            card.className = 'pending-card';
            card.innerHTML = `
                <span>❓</span>
                <span class="player-name">${p.playerName}</span>
                <div class="pending-actions">
                    <button class="btn btn-small btn-success approve-btn" data-id="${p.inGameID}" style="width:auto">✓ Approve</button>
                    <button class="btn btn-small btn-danger  reject-btn"  data-id="${p.inGameID}" style="width:auto">❌ Reject</button>
                </div>`;
            pendEl.appendChild(card);
        }
        pendEl.querySelectorAll('.approve-btn').forEach(b => { b.onclick = () => lh.approveJoin(parseInt(b.dataset.id), true);  });
        pendEl.querySelectorAll('.reject-btn') .forEach(b => { b.onclick = () => lh.approveJoin(parseInt(b.dataset.id), false); });

        // Bottom buttons
        const returnBtn = document.getElementById('btnReturnToGame');
        const joinBtn   = document.getElementById('btnJoinInProgress');
        const startBtn  = document.getElementById('btnLobbyStart');

        returnBtn.style.display = lh.hasActiveGame ? '' : 'none';

        const serverActive = this.serverGameActive();
        joinBtn.style.display = (!isHost && !lh.hasActiveGame && serverActive && !isPVP) ? '' : 'none';

        // Use centralized start-button state
        startBtn.style.display = ui.modalState.lobbyStartButtonVisible ? '' : 'none';
        startBtn.textContent   = ui.modalState.lobbyStartButtonText;
        startBtn.disabled      = !ui.modalState.lobbyStartButtonEnabled;
        startBtn.style.opacity = ui.modalState.lobbyStartButtonEnabled ? '1' : '0.7';
        startBtn.className     = 'btn btn-accent';
    }

    // ========================================================================
    // Network bar
    // ========================================================================

    updateNetworkBar() {
        const ui   = this.ui;
        const lh   = ui.lobbyHandler;
        const el   = document.getElementById('networkBar');
        if (!ui.isInLobby) { el.classList.remove('visible'); return; }
        el.classList.add('visible');

        const isHost             = lh.role === NetworkRole.Host;
        const isPVP              = lh.gameData.gameType === GameType.PVPDuel;
        const isCoOpSoft         = lh.gameData.gameType === GameType.CoOpSoft;
        const isCommunity        = lh.gameData.gameType === GameType.Community;
        const isSoloLeaderboard  = lh.gameData.gameType === GameType.SoloLeaderboard;
        const isAllReady         = ui.modalState.showReadyIndicators;
        const showState          = isCoOpSoft || isPVP || isCommunity;

        // Mirror Qt NetworkBar: chatButton visible: !isSoloLeaderboard
        const chatBtnWrap = document.getElementById('btnNetChat').parentElement;
        chatBtnWrap.style.display = isSoloLeaderboard ? 'none' : '';
        if (isSoloLeaderboard) ui.chat.closeChatPanel();

        document.getElementById('netRole').textContent   = isHost ? '🌐 Hosting' : '🔌 Connected';
        document.getElementById('netGameID').textContent = '• Game ID: ' + lh.lobbyID;

        const playerRow = document.getElementById('netPlayerRow');
        let html = `<span class="netbar-players-label">Players (${lh.players.length})</span>`;

        // Player tags in a flex-growing wrapper so buttons are pushed right
        html += `<span class="netbar-player-tags">`;
        lh.players.forEach((p, idx) => {
            const color      = getPlayerColorHex(p.inGameID, lh.gameData.gameType);
            const icon       = p.inGameID === 1 ? '👑' : '👤';
            const isSelf     = p.inGameID === lh.ownPlayerID;
            const nameClass  = (isSelf ? ' self' : '') + (p.inGameID === 1 ? ' host-player' : '');
            const stateEmoji = showState
                ? (p.state === PlayerState.Alive ? '💚' : p.state === PlayerState.Dead ? '💀' : '👁️')
                : '';
            const kickBtn    = (isHost && p.inGameID !== lh.ownPlayerID)
                ? `<button class="npt-kick" data-kid="${p.inGameID}">❌</button>` : '';
            const readyInd   = isAllReady
                ? `<span class="npt-ready${p.isReady ? ' ready' : ''}">${p.isReady ? '✓' : '○'}</span>` : '';

            html += `<span class="net-player-tag" style="background:${color}">
                <span class="npt-icon">${icon}</span>
                <span class="npt-name${nameClass}">${p.playerName}</span>
                ${stateEmoji ? `<span class="npt-state">${stateEmoji}</span>` : ''}
                ${readyInd} ${kickBtn}
            </span>`;
        });
        html += `</span>`;

        // Ready button (PVP Duel) — right-aligned
        if (isAllReady) {
            const isReady = ui.modalState.isOwnPlayerReady;
            html += `<button class="netbar-ready-btn${isReady ? ' is-ready' : ''}" id="netReadyBtn">
                ${isReady ? 'Ready!' : 'Ready Up'}
                <span class="npt-ready${isReady ? ' ready' : ''}">${isReady ? '✓' : '○'}</span>
            </button>`;
        }

        // Respawn button (Community) — right-aligned
        if (ui.modalState.showNetworkRespawnButton) {
            const canRespawn = ui.modalState.respawnButtonEnabled;
            html += `<button class="netbar-respawn-btn${canRespawn ? ' enabled' : ''}" id="netRespawnBtn"
                ${canRespawn ? '' : 'disabled'}>${ui.modalState.respawnButtonText}</button>`;
        }

        playerRow.innerHTML = html;

        playerRow.querySelectorAll('.npt-kick').forEach(btn => {
            btn.onclick = (e) => { e.stopPropagation(); lh.kickPlayer(parseInt(btn.dataset.kid)); };
        });
        const readyBtn = playerRow.querySelector('#netReadyBtn');
        if (readyBtn) {
            readyBtn.onclick = () => {
                ui.handleLobbyStartAction();
            };
        }
        const respawnBtn = playerRow.querySelector('#netRespawnBtn');
        if (respawnBtn) {
            respawnBtn.onclick = () => {
                if (ui.modalState.respawnButtonEnabled) {
                    ui.lobbyHandler.sendRespawnRequest();
                }
            };
        }

        // Pending row
        const pendRow = document.getElementById('netPendingRow');
        if (isHost && lh.pendingPlayers.length > 0) {
            pendRow.style.display = '';
            let ph = `<span class="netbar-pending-label">Pending Players (${lh.pendingPlayers.length})</span>`;
            lh.pendingPlayers.forEach(p => {
                ph += `<span class="net-pending-tag">
                    <span>❓ ${p.playerName}</span>
                    <button class="npt-approve" data-pid="${p.inGameID}">✔️</button>
                    <button class="npt-reject"  data-pid="${p.inGameID}">❌</button>
                </span>`;
            });
            pendRow.innerHTML = ph;
            pendRow.querySelectorAll('.npt-approve').forEach(btn => {
                btn.onclick = (e) => { e.stopPropagation(); lh.approveJoin(parseInt(btn.dataset.pid), true);  };
            });
            pendRow.querySelectorAll('.npt-reject').forEach(btn => {
                btn.onclick = (e) => { e.stopPropagation(); lh.approveJoin(parseInt(btn.dataset.pid), false); };
            });
        } else {
            pendRow.style.display = 'none';
        }

        // Respawn cooldown tick — update the button text every second
        this._startRespawnTick();
    }

    _startRespawnTick() {
        clearInterval(this._respawnTickId);
        this._respawnTickId = 0;
        const ms = this.ui.modalState;
        if (!ms.showNetworkRespawnButton || ms.respawnCooldownRemaining <= 0) return;
        this._respawnTickId = setInterval(() => {
            const btn = document.getElementById('netRespawnBtn');
            if (!btn || ms.respawnCooldownRemaining <= 0) {
                clearInterval(this._respawnTickId);
                this._respawnTickId = 0;
                // Final update once cooldown expires
                if (btn) {
                    btn.textContent = ms.respawnButtonText;
                    btn.disabled = !ms.respawnButtonEnabled;
                    btn.classList.toggle('enabled', ms.respawnButtonEnabled);
                }
                return;
            }
            btn.textContent = ms.respawnButtonText;
        }, 1000);
    }

    // ========================================================================
    // Public lobby browser
    // ========================================================================

    renderPublicLobbies() {
        const ui = this.ui;

    /**
     * Called by onPublicLobbiesLoaded when a server response is fully assembled.
     * Snapshots the response into the right list, chains the second request if
     * needed, or renders the UI from the two stable snapshots.
     */
    renderPublicLobbies() {
        const ui = this.ui;
        const lobbies = [...ui.queryHandler.publicLobbies];

        if (this._currentQueryType === 1) {
            // Community response just arrived
            this._communityLobbies = lobbies;

            // If player lobbies are also wanted, chain that request now
            if (this._showPlayerLobbies) {
                this._currentQueryType = 0;
                ui.queryHandler.requestPublicLobbies(0, this._pubPage, PAGE_SIZE);
                return; // wait for player-lobbies response before rendering
            }
        } else {
            // Player-lobbies response just arrived
            this._playerLobbies = lobbies.filter(l => l.gameType !== GameType.Community);
        }

        this._renderFromSnapshots();
    }

    /** Renders the list UI purely from the two stable snapshot arrays. */
    _renderFromSnapshots() {
        const ui = this.ui;
        const communitySource = this._showCommunity ? this._communityLobbies : [];

        const anyFilter = this._filterCoOpSoft || this._filterCoOpHard || this._filterPVPDuel;
        const playerSource = this._showPlayerLobbies
            ? (anyFilter
                ? this._playerLobbies.filter(l => {
                    if (this._filterCoOpSoft && l.gameType === GameType.CoOpSoft) return true;
                    if (this._filterCoOpHard && l.gameType === GameType.CoOpHard) return true;
                    if (this._filterPVPDuel  && l.gameType === GameType.PVPDuel)  return true;
                    return false;
                  })
                : this._playerLobbies)
            : [];

        const combined = [...communitySource, ...playerSource];
        const list    = document.getElementById('publicLobbyList');
        list.innerHTML = '';
        const total   = ui.queryHandler.publicLobbyTotalCount;
        const typeNames = ['Cooperative Hardcore', 'Cooperative Softcore', 'Solo Leaderboard', 'PVP Duel', 'Community'];

        if (combined.length === 0) {
            let msg;
            if (!this._showPlayerLobbies && !this._showCommunity)
                msg = 'Select Player Lobbies or Community to browse games.';
            else if (this._showCommunity && !this._showPlayerLobbies)
                msg = 'No community games available. Try refreshing!';
            else if (anyFilter)
                msg = 'No lobbies match this filter. Try another mode or refresh.';
            else
                msg = 'No player lobbies available. Create one or refresh to check again!';
            list.innerHTML = `<div class="list-empty">${msg}</div>`;
        } else {
            const typeBadgeClass = [
                'gb-type-coophard',   // 0 CoOpHard
                'gb-type-coopsoft',   // 1 CoOpSoft
                'gb-type-other',      // 2 SoloLeaderboard
                'gb-type-pvpduel',    // 3 PVPDuel
                'gb-type-community',  // 4 Community
            ];
            const typeAccentColor = [
                '#D32F2F',  // 0 CoOpHard
                '#388E3C',  // 1 CoOpSoft
                '#3498DB',  // 2 SoloLeaderboard
                '#7B1FA2',  // 3 PVPDuel
                '#1976D2',  // 4 Community
            ];
            for (const lobby of combined) {
                const entry = document.createElement('div');
                entry.className = 'gb-entry';
                entry.style.setProperty('--gb-accent', typeAccentColor[lobby.gameType] || '#3498DB');

                const cooldown = ui.settings.getRespawnCooldown(lobby.gameID);
                const now = Date.now();
                let cooldownHtml = '';
                if (cooldown > now) {
                    const remaining = cooldown - now;
                    const h = Math.floor(remaining / 3600000);
                    const m = Math.floor((remaining % 3600000) / 60000);
                    const s = Math.floor((remaining % 60000) / 1000);
                    cooldownHtml = `<div class="gb-cooldown" data-expire="${cooldown}">⏳ Cooldown: ${h}h ${m}m ${s}s</div>`;
                } else if (lobby.respawnCooldownMs > 0) {
                    const h = Math.floor(lobby.respawnCooldownMs / 3600000);
                    const m = Math.floor((lobby.respawnCooldownMs % 3600000) / 60000);
                    const s = Math.floor((lobby.respawnCooldownMs % 60000) / 1000);
                    cooldownHtml = `<div class="gb-cooldown static">⚠️ Death Cooldown: ${h}h ${m}m ${s}s</div>`;
                }

                const g = lobby.grid || {};
                const gridSubRow = (g.w && g.h)
                    ? `<div class="gb-sub-row">${g.w} × ${g.h} &nbsp;•&nbsp; ${g.density}% density</div>`
                    : '';
                const badgeClass = typeBadgeClass[lobby.gameType] || 'gb-type-other';

                entry.innerHTML = `
                    <div class="gb-entry-row">
                        <span class="gb-type-badge ${badgeClass}">${typeNames[lobby.gameType] || 'Unknown'}</span>
                        <span class="gb-host">🎮 ${lobby.hostName}</span>
                        <span class="gb-players">${lobby.playerCount} 👤</span>
                    </div>
                    ${gridSubRow}
                    ${cooldownHtml}
                `;
                entry.onclick = () => {
                    const isPlayerLobby = lobby.gameType !== GameType.Community;
                    if (isPlayerLobby && cooldown > Date.now()) {
                        const remaining = cooldown - Date.now();
                        const hours = Math.floor(remaining / 3600000);
                        const mins = Math.floor((remaining % 3600000) / 60000);
                        const secs = Math.floor((remaining % 60000) / 1000);
                        ui._showToast(`You are still on cooldown for this game. Try again in ${hours}h ${mins}m ${secs}s.`);
                        return;
                    }
                    this.joinPublicLobby(lobby.gameID);
                };
                list.appendChild(entry);
            }
        }

        document.getElementById('btnPublicPrev').disabled    = this._pubPage === 0;
        document.getElementById('btnPublicNext').disabled    = total <= PAGE_SIZE * (this._pubPage + 1);
        document.getElementById('publicPageInfo').textContent = 'Page ' + (this._pubPage + 1);
        this._startPubCooldownTick();
    }

    _startPubCooldownTick() {
        clearInterval(this._pubCooldownTickId);
        this._pubCooldownTickId = 0;
        const list = document.getElementById('publicLobbyList');
        if (!list || !list.querySelector('.gb-cooldown[data-expire]')) return;
        this._pubCooldownTickId = setInterval(() => {
            const now = Date.now();
            const els = document.querySelectorAll('#publicLobbyList .gb-cooldown[data-expire]');
            if (els.length === 0) {
                clearInterval(this._pubCooldownTickId);
                this._pubCooldownTickId = 0;
                return;
            }
            for (const el of els) {
                const rem = parseInt(el.dataset.expire) - now;
                if (rem <= 0) {
                    el.removeAttribute('data-expire');
                    el.textContent = '';
                    el.style.display = 'none';
                    el.removeAttribute('data-expire');
                    el.textContent = '';
                } else {
                    const h = Math.floor(rem / 3600000);
                    const m = Math.floor((rem % 3600000) / 60000);
                    const s = Math.floor((rem % 60000) / 1000);
                    el.textContent = `⏳ Cooldown: ${h}h ${m}m ${s}s`;
                }
            }
        }, 1000);
    }

    joinPublicLobby(gameID) {
        const ui   = this.ui;
        const name = ui.settings.get('playerName') || 'Player';
        if (!name) { ui._showToast('Set a player name in App Settings first'); return; }
        clearInterval(this._pubCooldownTickId);
        this._pubCooldownTickId = 0;
        ui.lobbyHandler.joinGame(name, gameID);
        ui._showScreen('mainMenu');
    }

    refreshPublicLobbies(pageDelta = 0) {
        this._pubPage = Math.max(0, this._pubPage + pageDelta);
        this._communityLobbies = [];
        this._doRequest();
    }
}
