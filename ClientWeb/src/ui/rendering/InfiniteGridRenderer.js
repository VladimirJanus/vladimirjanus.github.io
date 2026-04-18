// InfiniteGridRenderer.js - Canvas renderer for infinite minesweeper
// ============================================================================

import { CellContent, CellState, ClickType } from '../../core/CoreEnums.js';

// Shared SVG assets for digital numbers/textures (same set as GridRenderer.js)
const INFINITE_SVG_ASSETS = {
    n1: 'src/assets/grid/1.svg',  n2: 'src/assets/grid/2.svg',
    n3: 'src/assets/grid/3.svg',  n4: 'src/assets/grid/4.svg',
    n5: 'src/assets/grid/5.svg',  n6: 'src/assets/grid/6.svg',
    n7: 'src/assets/grid/7.svg',  n8: 'src/assets/grid/8.svg',
    flag: 'src/assets/grid/flag.svg',
    mine: 'src/assets/grid/mine.svg',
};
const _infiniteSprites = new Map();
let   _infiniteSpritesLoaded = false;

function _ensureInfiniteSprites(onUpdate) {
    if (_infiniteSpritesLoaded) return;
    _infiniteSpritesLoaded = true;
    for (const [key, src] of Object.entries(INFINITE_SVG_ASSETS)) {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => { if (onUpdate) onUpdate(); };
        img.src = src;
        _infiniteSprites.set(key, img);
    }
}

const BG_COLOR = '#333333';
const HIDDEN_COLOR = '#888888';
const REVEALED_COLOR = '#bbbbbb';
const BORDER_COLOR = '#333333';

const NUMBER_COLORS = [
    '#0000ff', '#008000', '#ff0000', '#000080',
    '#800000', '#008080', '#000000', '#808080',
];

const CLICK_THRESHOLD = 10;
const LONG_PRESS_MS = 420;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function easeInOutQuad(t) {
    if (t < 0.5) return 2 * t * t;
    return 1 - 2 * (1 - t) * (1 - t);
}

export class InfiniteGridRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.gridManager = null;

        this.cellSize = 28;
        this.minScale = 0.2;
        this.maxScale = 4.0;
        this.scale = 1.0;
        this.spacing = 1;

        this.centerX = 0.5;
        this.centerY = 0.5;

        this.inert = true;

        this.showLastArrow = false;
        this.lastArrowAngle = 0;
        this.showOriginArrow = false;
        this.originArrowAngle = 0;

        this.onCellClick = null;
        this.onArrowDataChanged = null;

        this._running = false;
        this._rafId = 0;
        this._dirty = true;

        this._mouseIsDown = false;
        this._dragging = false;
        this._dragSX = 0;
        this._dragSY = 0;
        this._lastMouseX = 0;
        this._lastMouseY = 0;
        this._moved = false;
        this._isRightClick = false;
        this._lpTimer = null;
        this._lpFired = false;

        this._isPinching = false;
        this._pinchStartDist = 1;
        this._pinchStartScale = 1;
        this._pinchStartCenterX = 0;
        this._pinchStartCenterY = 0;
        this._pinchStartViewX = 0;
        this._pinchStartViewY = 0;

        this._cachedRect = null;

        this._panAnimating = false;
        this._panStartX = 0;
        this._panStartY = 0;
        this._panTargetX = 0;
        this._panTargetY = 0;
        this._panStartTime = 0;
        this._panDurationMs = 210;

        // Keyboard selection state (mirrors Qt InfiniteGridRenderer)
        this._hasKbdSel = false;
        this._kbdSelX = 0;
        this._kbdSelY = 0;

        // Shift+Arrow smooth pan state
        this._shiftPanLeft  = false;
        this._shiftPanRight = false;
        this._shiftPanUp    = false;
        this._shiftPanDown  = false;
        this._kbdPanTimer    = null;
        this._kbdPanLastTime = 0;

        // Digital settings
        this._digitalNumbersEnabled  = false;
        this._digitalTexturesEnabled = false;

        this._paintFalseFlags = false;

        _ensureInfiniteSprites(() => this.requestRedraw());

        this._bindEvents();
        this.resize();
    }

    setGridManager(gridManager) {
        const isFreshGame = !gridManager || !this.gridManager ||
            gridManager !== this.gridManager;
        if (isFreshGame) {
            this._hasKbdSel = false;
            this._kbdSelX = 0;
            this._kbdSelY = 0;
            this._paintFalseFlags = false;
        }
        this.gridManager = gridManager;
        this._updateArrowState();
        this.requestRedraw();
    }

    setInert(inert) {
        if (!inert) this._paintFalseFlags = false;
        this.inert = !!inert;
    }

    revealFalseFlags() {
        this._paintFalseFlags = true;
        this.requestRedraw();
    }

    clearFalseFlags() {
        this._paintFalseFlags = false;
        this.requestRedraw();
    }

    show() {
        this.canvas.style.display = '';
        this.resize();
        this.startRenderLoop();
    }

    hide() {
        this.stopRenderLoop();
        this.canvas.style.display = 'none';
        this._hasKbdSel = false;
        this.stopAllKbdShiftPan();
    }

    startRenderLoop() {
        this._running = true;
        this.requestRedraw();
    }

    stopRenderLoop() {
        this._running = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }
    }

    requestRedraw() {
        this._dirty = true;
        this._scheduleFrame();
    }

    resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;

        const rect = parent.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width = Math.round(rect.width * dpr);
        this.canvas.height = Math.round(rect.height * dpr);
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;

        this._updateArrowState();
        this.requestRedraw();
    }

    resetView() {
        if (this._viewWidth() <= 0 || this._viewHeight() <= 0) return;

        this._stopPanAnimation();
        this.centerX = 0.5;
        this.centerY = 0.5;

        const fitScale = Math.min(this._viewWidth(), this._viewHeight()) / (this.cellSize * 15);
        this.scale = clamp(fitScale, this.minScale, this.maxScale);

        this._updateArrowState();
        this.requestRedraw();
    }

    panToCell(x, y) {
        this._startPanAnimation(Number(x) + 0.5, Number(y) + 0.5);
    }

    panToOrigin() {
        this.panToCell(0, 0);
    }

    panToLastReveal() {
        if (!this.gridManager || !this.gridManager.hasLastReveal) return;
        this.panToCell(this.gridManager.lastRevealX, this.gridManager.lastRevealY);
    }

    _viewWidth() {
        const dpr = window.devicePixelRatio || 1;
        return this.canvas.width / dpr;
    }

    _viewHeight() {
        const dpr = window.devicePixelRatio || 1;
        return this.canvas.height / dpr;
    }

    _stride() {
        return this.cellSize * this.scale + this.spacing;
    }

    _scheduleFrame() {
        if (!this._running || this._rafId) return;
        this._rafId = requestAnimationFrame((now) => {
            this._rafId = 0;
            if (!this._running) return;
            this._frame(now);
        });
    }

    _frame(now) {
        if (this._panAnimating) {
            this._stepPanAnimation(now);
            this._dirty = true;
        }

        if (this._dirty) {
            this._draw();
            this._dirty = false;
        }

        if (this._running && (this._dirty || this._panAnimating)) {
            this._scheduleFrame();
        }
    }

    _draw() {
        if (!this.ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const vw = this._viewWidth();
        const vh = this._viewHeight();

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.fillStyle = BG_COLOR;
        this.ctx.fillRect(0, 0, vw, vh);

        if (this.gridManager) {
            const stride = this._stride();
            if (stride > 0) {
                const halfCellsX = vw * 0.5 / stride;
                const halfCellsY = vh * 0.5 / stride;

                const startX = Math.floor(this.centerX - halfCellsX) - 1;
                const endX = Math.ceil(this.centerX + halfCellsX) + 1;
                const startY = Math.floor(this.centerY - halfCellsY) - 1;
                const endY = Math.ceil(this.centerY + halfCellsY) + 1;

                const drawSize = this.cellSize * this.scale;
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';

                for (let y = startY; y <= endY; y++) {
                    for (let x = startX; x <= endX; x++) {
                        const sx = vw * 0.5 + (x - this.centerX) * stride;
                        const sy = vh * 0.5 + (y - this.centerY) * stride;

                        if (sx + drawSize < 0 || sy + drawSize < 0 || sx > vw || sy > vh) {
                            continue;
                        }

                        const cell = this.gridManager.cellAt(x, y);
                        const isRevealed = cell.state === CellState.Revealed;

                        this.ctx.fillStyle = isRevealed ? REVEALED_COLOR : HIDDEN_COLOR;
                        this.ctx.fillRect(sx, sy, drawSize, drawSize);

                        this.ctx.strokeStyle = BORDER_COLOR;
                        this.ctx.lineWidth = 1;
                        this.ctx.strokeRect(sx + 0.5, sy + 0.5, drawSize - 1, drawSize - 1);

                        if (cell.state === CellState.Flagged) {
                            if (this._paintFalseFlags && cell.content !== CellContent.Mine) {
                                this._drawFalseFlag(sx, sy, drawSize);
                            } else {
                                this._drawFlag(sx, sy, drawSize);
                            }
                            continue;
                        }

                        if (isRevealed && cell.content === CellContent.Mine) {
                            this._drawMine(sx, sy, drawSize);
                            continue;
                        }

                        if (isRevealed && cell.content === CellContent.Safe) {
                            const adj = this.gridManager.adjacentMines(x, y);
                            if (adj > 0) {
                                if (this._digitalNumbersEnabled) {
                                    this._drawSvgGlyph(`n${adj}`, sx, sy, drawSize);
                                } else {
                                    this.ctx.fillStyle = NUMBER_COLORS[Math.min(adj, 8) - 1] || '#000000';
                                    this.ctx.font = `bold ${Math.floor(drawSize * 0.64)}px Segoe UI`;
                                    this.ctx.fillText(String(adj), sx + drawSize * 0.5, sy + drawSize * 0.54);
                                }
                            }
                        }
                    }
                }
            }
        }

        this._drawArrows(vw, vh);
        this._drawKbdCursor(vw, vh);
    }

    _drawSvgGlyph(key, x, y, size) {
        const img = _infiniteSprites.get(key);
        if (img && img.complete && img.naturalWidth > 0) {
            const pad = size * 0.1;
            this.ctx.drawImage(img, x + pad, y + pad, size - pad * 2, size - pad * 2);
            return true;
        }
        return false;
    }

    setDigitalNumbersEnabled(enabled) {
        const normalized = !!enabled;
        if (this._digitalNumbersEnabled === normalized) return;
        this._digitalNumbersEnabled = normalized;
        this.requestRedraw();
    }

    setDigitalTexturesEnabled(enabled) {
        const normalized = !!enabled;
        if (this._digitalTexturesEnabled === normalized) return;
        this._digitalTexturesEnabled = normalized;
        this.requestRedraw();
    }

    _drawFlag(x, y, size) {
        if (this._digitalTexturesEnabled && this._drawSvgGlyph('flag', x, y, size)) return;
        this.ctx.font = `${Math.floor(size * 0.68)}px serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = '#000000';
        this.ctx.fillText('🚩', x + size * 0.5, y + size * 0.54);
    }

    _drawFalseFlag(x, y, size) {
        this.ctx.font = `${Math.floor(size * 0.68)}px serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = '#000000';
        this.ctx.fillText('❌', x + size * 0.5, y + size * 0.54);
    }

    _drawMine(x, y, size) {
        if (this._digitalTexturesEnabled && this._drawSvgGlyph('mine', x, y, size)) return;
        this.ctx.font = `${Math.floor(size * 0.68)}px serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = '#000000';
        this.ctx.fillText('💣', x + size * 0.5, y + size * 0.54);
    }

    _drawArrows(vw, vh) {
        if (this.showLastArrow) {
            const p = this._arrowPoint(this.lastArrowAngle, vw, vh);
            this._drawArrowBadge(p.x, p.y, this.lastArrowAngle, '#f39c12', 'L');
        }
        if (this.showOriginArrow) {
            const p = this._arrowPoint(this.originArrowAngle, vw, vh);
            this._drawArrowBadge(p.x, p.y, this.originArrowAngle, '#3498db', 'O');
        }
    }

    _drawArrowBadge(x, y, angleDeg, color, label) {
        const r = 22;
        this.ctx.save();

        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        this.ctx.beginPath();
        this.ctx.arc(x, y, r + 2, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.arc(x, y, r, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        this.ctx.translate(x, y);
        this.ctx.rotate((angleDeg * Math.PI) / 180);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.beginPath();
        this.ctx.moveTo(9, 0);
        this.ctx.lineTo(-6, 6);
        this.ctx.lineTo(-6, -6);
        this.ctx.closePath();
        this.ctx.fill();

        this.ctx.restore();

        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = 'bold 10px Segoe UI';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(label, x, y + 15);
    }

    _drawKbdCursor(vw, vh) {
        if (!this._hasKbdSel) return;
        const worldStride = this._stride();
        if (worldStride <= 0) return;
        const drawSize = this.cellSize * this.scale;
        const sx = vw * 0.5 + (this._kbdSelX - this.centerX) * worldStride;
        const sy = vh * 0.5 + (this._kbdSelY - this.centerY) * worldStride;
        const bw = Math.max(2, 1);
        this.ctx.strokeStyle = 'rgba(255, 230, 120, 0.90)';
        this.ctx.lineWidth = bw;
        this.ctx.strokeRect(sx + bw * 0.5, sy + bw * 0.5, drawSize - bw, drawSize - bw);
    }

    _arrowPoint(angleDeg, vw, vh) {
        const edgeRadius = Math.max(28, Math.min(vw, vh) * 0.5 - 34);
        const rad = (angleDeg * Math.PI) / 180;
        return {
            x: vw * 0.5 + Math.cos(rad) * edgeRadius,
            y: vh * 0.5 + Math.sin(rad) * edgeRadius,
        };
    }

    _hitTestArrow(px, py) {
        const vw = this._viewWidth();
        const vh = this._viewHeight();
        const hitRadius = 24;

        if (this.showLastArrow) {
            const p = this._arrowPoint(this.lastArrowAngle, vw, vh);
            const dx = px - p.x;
            const dy = py - p.y;
            if (dx * dx + dy * dy <= hitRadius * hitRadius) return 'last';
        }

        if (this.showOriginArrow) {
            const p = this._arrowPoint(this.originArrowAngle, vw, vh);
            const dx = px - p.x;
            const dy = py - p.y;
            if (dx * dx + dy * dy <= hitRadius * hitRadius) return 'origin';
        }

        return '';
    }

    _updateArrowState() {
        let showOriginArrow = false;
        let originArrowAngle = 0;
        let showLastArrow = false;
        let lastArrowAngle = 0;

        const worldStride = this._stride();
        if (this.gridManager && this._viewWidth() > 0 && this._viewHeight() > 0 && worldStride > 0) {
            const halfW = (this._viewWidth() * 0.5) / worldStride;
            const halfH = (this._viewHeight() * 0.5) / worldStride;
            const minX = this.centerX - halfW;
            const maxX = this.centerX + halfW;
            const minY = this.centerY - halfH;
            const maxY = this.centerY + halfH;

            const isVisible = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;

            showOriginArrow = !isVisible(0, 0);
            if (showOriginArrow) {
                originArrowAngle = (Math.atan2(-this.centerY, -this.centerX) * 180) / Math.PI;
            }

            if (this.gridManager.hasLastReveal) {
                const lx = this.gridManager.lastRevealX;
                const ly = this.gridManager.lastRevealY;
                showLastArrow = !isVisible(lx, ly);
                if (showLastArrow) {
                    const dx = lx - this.centerX;
                    const dy = ly - this.centerY;
                    lastArrowAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
                }
            }
        }

        const changed = this.showOriginArrow !== showOriginArrow
            || Math.abs(this.originArrowAngle - originArrowAngle) > 0.0001
            || this.showLastArrow !== showLastArrow
            || Math.abs(this.lastArrowAngle - lastArrowAngle) > 0.0001;

        if (!changed) return;

        this.showOriginArrow = showOriginArrow;
        this.originArrowAngle = originArrowAngle;
        this.showLastArrow = showLastArrow;
        this.lastArrowAngle = lastArrowAngle;

        if (this.onArrowDataChanged) {
            this.onArrowDataChanged({
                showOriginArrow: this.showOriginArrow,
                originArrowAngle: this.originArrowAngle,
                showLastArrow: this.showLastArrow,
                lastArrowAngle: this.lastArrowAngle,
            });
        }
    }

    _screenToCell(sx, sy) {
        const worldStride = this._stride();
        if (worldStride <= 0) return { x: 0, y: 0 };
        const wx = this.centerX + (sx - this._viewWidth() * 0.5) / worldStride;
        const wy = this.centerY + (sy - this._viewHeight() * 0.5) / worldStride;
        return { x: Math.floor(wx), y: Math.floor(wy) };
    }

    _zoomAt(factor, sx, sy) {
        this._stopPanAnimation();

        const oldStride = this._stride();
        if (oldStride <= 0) return;

        const worldX = this.centerX + (sx - this._viewWidth() * 0.5) / oldStride;
        const worldY = this.centerY + (sy - this._viewHeight() * 0.5) / oldStride;

        this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);

        const newStride = this._stride();
        if (newStride <= 0) return;

        this.centerX = worldX - (sx - this._viewWidth() * 0.5) / newStride;
        this.centerY = worldY - (sy - this._viewHeight() * 0.5) / newStride;

        this._updateArrowState();
        this.requestRedraw();
    }

    _startPanAnimation(targetX, targetY) {
        const dx = targetX - this.centerX;
        const dy = targetY - this.centerY;
        if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
            this.centerX = targetX;
            this.centerY = targetY;
            this._updateArrowState();
            this.requestRedraw();
            return;
        }

        this._panStartX = this.centerX;
        this._panStartY = this.centerY;
        this._panTargetX = targetX;
        this._panTargetY = targetY;
        this._panStartTime = performance.now();
        this._panAnimating = true;
        this.requestRedraw();
    }

    _stepPanAnimation(now) {
        if (!this._panAnimating) return;

        const t = clamp((now - this._panStartTime) / this._panDurationMs, 0, 1);
        const eased = easeInOutQuad(t);

        this.centerX = this._panStartX + (this._panTargetX - this._panStartX) * eased;
        this.centerY = this._panStartY + (this._panTargetY - this._panStartY) * eased;
        this._updateArrowState();

        if (t >= 1) {
            this._panAnimating = false;
        }
    }

    _stopPanAnimation() {
        this._panAnimating = false;
    }

    // ========================================================================
    // Keyboard selection (mirrors Qt InfiniteGridRenderer)
    // ========================================================================

    ensureKbdSelection() {
        if (!this.gridManager) return false;
        if (this._hasKbdSel) return true;
        // Keep pre-seeded (0,0) so first key action is deterministic
        this._hasKbdSel = true;
        this.requestRedraw();
        return true;
    }

    moveKbdSelection(dx, dy) {
        if (!this.ensureKbdSelection()) return;
        this._stopPanAnimation();
        this._kbdSelX += dx;
        this._kbdSelY += dy;
        this._keepSelectionVisible();
        this.requestRedraw();
    }

    hideKbdSelection() {
        if (!this._hasKbdSel) return;
        this._hasKbdSel = false;
        this.requestRedraw();
    }

    keyboardRevealSelected() {
        if (!this.gridManager || this.inert) return;
        if (!this.ensureKbdSelection()) return;
        if (this.onCellClick) this.onCellClick(this._kbdSelX, this._kbdSelY, ClickType.LeftClick);
    }

    keyboardFlagSelected() {
        if (!this.gridManager || this.inert) return;
        if (!this.ensureKbdSelection()) return;
        if (this.onCellClick) this.onCellClick(this._kbdSelX, this._kbdSelY, ClickType.RightClick);
    }

    keyboardZoomIn() {
        if (!this.gridManager || this.inert) return;
        this._zoomAt(1.15, this._viewWidth() * 0.5, this._viewHeight() * 0.5);
    }

    keyboardZoomOut() {
        if (!this.gridManager || this.inert) return;
        this._zoomAt(1 / 1.15, this._viewWidth() * 0.5, this._viewHeight() * 0.5);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Shift+Arrow smooth pan  (mirrors Qt InfiniteGridRenderer / GridRenderer shift-pan)
    // ═══════════════════════════════════════════════════════════════════════\n
    startKbdShiftPan(key) {
        switch (key) {
        case 'ArrowLeft':  this._shiftPanLeft  = true; break;
        case 'ArrowRight': this._shiftPanRight = true; break;
        case 'ArrowUp':    this._shiftPanUp    = true; break;
        case 'ArrowDown':  this._shiftPanDown  = true; break;
        }
        if (!this._kbdPanTimer && this._anyShiftPanKey()) {
            this._kbdPanLastTime = performance.now();
            this._kbdPanTimer = setInterval(() => this._stepKbdPan(), 16);
        }
    }

    stopKbdShiftPan(key) {
        switch (key) {
        case 'ArrowLeft':  this._shiftPanLeft  = false; break;
        case 'ArrowRight': this._shiftPanRight = false; break;
        case 'ArrowUp':    this._shiftPanUp    = false; break;
        case 'ArrowDown':  this._shiftPanDown  = false; break;
        }
        if (!this._anyShiftPanKey()) this._stopKbdPanTimer();
    }

    stopAllKbdShiftPan() {
        this._shiftPanLeft = this._shiftPanRight = this._shiftPanUp = this._shiftPanDown = false;
        this._stopKbdPanTimer();
    }

    _anyShiftPanKey() {
        return this._shiftPanLeft || this._shiftPanRight || this._shiftPanUp || this._shiftPanDown;
    }

    _stopKbdPanTimer() {
        if (this._kbdPanTimer) { clearInterval(this._kbdPanTimer); this._kbdPanTimer = null; }
    }

    _stepKbdPan() {
        if (this.inert || !this._anyShiftPanKey()) { this._stopKbdPanTimer(); return; }
        const now = performance.now();
        const dt  = Math.min((now - this._kbdPanLastTime) / 1000, 0.05);
        this._kbdPanLastTime = now;
        const stride = this._stride();
        if (stride <= 0) return;
        const speedPx  = Math.max(420, 14 * stride);  // px/s, mirrors Qt keyboardPanSpeedPxPerSec (min=420, mult=14)
        const speedCell = speedPx / stride;            // world cells/s
        // Arrow = viewport motion direction → centerX is the camera center;
        // moving viewport right means center moves right → centerX increases.
        this.centerX += ((this._shiftPanRight ? 1 : 0) - (this._shiftPanLeft  ? 1 : 0)) * speedCell * dt;
        this.centerY += ((this._shiftPanDown  ? 1 : 0) - (this._shiftPanUp    ? 1 : 0)) * speedCell * dt;
        this._updateArrowState();
        this.requestRedraw();
    }

    _keepSelectionVisible() {
        const worldStride = this._stride();
        if (worldStride <= 0 || this._viewWidth() <= 0 || this._viewHeight() <= 0) return;
        const drawSize = this.cellSize * this.scale;
        const vw = this._viewWidth(), vh = this._viewHeight();
        const cellLeft = vw * 0.5 + (this._kbdSelX - this.centerX) * worldStride;
        const cellTop  = vh * 0.5 + (this._kbdSelY - this.centerY) * worldStride;
        if (cellLeft < 0)                      this.centerX += cellLeft / worldStride;
        else if (cellLeft + drawSize > vw)     this.centerX += (cellLeft + drawSize - vw) / worldStride;
        if (cellTop < 0)                       this.centerY += cellTop / worldStride;
        else if (cellTop + drawSize > vh)      this.centerY += (cellTop + drawSize - vh) / worldStride;
        this._updateArrowState();
    }

    _bindEvents() {
        const c = this.canvas;

        c.addEventListener('contextmenu', (e) => e.preventDefault());

        c.addEventListener('mousedown', (e) => this._mouseDown(e));
        c.addEventListener('mousemove', (e) => this._mouseMove(e));
        c.addEventListener('mouseup', (e) => this._mouseUp(e));

        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.inert) return;
            const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
            this._zoomAt(factor, e.offsetX, e.offsetY);
        }, { passive: false });

        c.addEventListener('touchstart', (e) => this._touchEvent(e), { passive: false });
        c.addEventListener('touchmove', (e) => this._touchEvent(e), { passive: false });
        c.addEventListener('touchend', (e) => this._touchEvent(e), { passive: false });
        c.addEventListener('touchcancel', (e) => this._touchEvent(e), { passive: false });
    }

    _mouseDown(e) {
        if (this.inert) return;

        this._stopPanAnimation();

        // Clear keyboard selection on mouse interaction
        if (this._hasKbdSel) {
            this._hasKbdSel = false;
            this._dirty = true;
        }

        this._mouseIsDown = true;
        this._dragSX = e.offsetX;
        this._dragSY = e.offsetY;
        this._lastMouseX = e.offsetX;
        this._lastMouseY = e.offsetY;
        this._moved = false;
        this._lpFired = false;
        this._dragging = false;
        this._isRightClick = e.button === 2;

        if (this._isRightClick) {
            const arrowHit = this._hitTestArrow(e.offsetX, e.offsetY);
            if (arrowHit) {
                if (arrowHit === 'origin') this.panToOrigin();
                if (arrowHit === 'last') this.panToLastReveal();
                return;
            }
            const cell = this._screenToCell(e.offsetX, e.offsetY);
            if (this.onCellClick) this.onCellClick(cell.x, cell.y, ClickType.RightClick);
        } else {
            this._startLongPress(e.offsetX, e.offsetY);
        }
    }

    _mouseMove(e) {
        if (!this._mouseIsDown || this.inert || this._isRightClick) return;

        const dx = e.offsetX - this._dragSX;
        const dy = e.offsetY - this._dragSY;

        if (!this._moved) {
            const dist = Math.hypot(dx, dy);
            if (dist > CLICK_THRESHOLD) {
                this._moved = true;
                this._dragging = true;
                this._cancelLongPress();
            }
        }

        if (this._dragging) {
            const worldStride = this._stride();
            if (worldStride > 0) {
                const mdx = e.offsetX - this._lastMouseX;
                const mdy = e.offsetY - this._lastMouseY;
                this.centerX -= mdx / worldStride;
                this.centerY -= mdy / worldStride;
                this._updateArrowState();
                this.requestRedraw();
            }
        }

        this._lastMouseX = e.offsetX;
        this._lastMouseY = e.offsetY;
    }

    _mouseUp(e) {
        if (this.inert) return;

        this._mouseIsDown = false;
        this._cancelLongPress();

        if (!this._isRightClick && !this._moved && !this._lpFired) {
            const arrowHit = this._hitTestArrow(e.offsetX, e.offsetY);
            if (arrowHit === 'origin') {
                this.panToOrigin();
            } else if (arrowHit === 'last') {
                this.panToLastReveal();
            } else {
                const cell = this._screenToCell(e.offsetX, e.offsetY);
                if (this.onCellClick) this.onCellClick(cell.x, cell.y, ClickType.LeftClick);
            }
        }

        this._dragging = false;
        this._isRightClick = false;
        this._lpFired = false;
    }

    _touchEvent(e) {
        e.preventDefault();
        if (this.inert) return;

        const touches = e.touches;
        const type = e.type;

        if (type === 'touchstart') {
            this._cachedRect = this.canvas.getBoundingClientRect();
        }

        if (touches.length === 2) {
            this._cancelLongPress();
            this._moved = true;

            const p1 = this._touchPos(touches[0]);
            const p2 = this._touchPos(touches[1]);
            const cx = (p1.x + p2.x) * 0.5;
            const cy = (p1.y + p2.y) * 0.5;
            const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

            if (!this._isPinching) {
                this._stopPanAnimation();
                this._isPinching = true;
                this._pinchStartDist = Math.max(1, dist);
                this._pinchStartScale = this.scale;
                this._pinchStartCenterX = cx;
                this._pinchStartCenterY = cy;
                this._pinchStartViewX = this.centerX;
                this._pinchStartViewY = this.centerY;
                return;
            }

            const newScale = clamp(
                this._pinchStartScale * (dist / this._pinchStartDist),
                this.minScale,
                this.maxScale
            );

            const stride0 = this.cellSize * this._pinchStartScale + this.spacing;
            const gx = this._pinchStartViewX + (this._pinchStartCenterX - this._viewWidth() * 0.5) / stride0;
            const gy = this._pinchStartViewY + (this._pinchStartCenterY - this._viewHeight() * 0.5) / stride0;

            this.scale = newScale;
            const strideN = this._stride();
            this.centerX = gx - (cx - this._viewWidth() * 0.5) / strideN;
            this.centerY = gy - (cy - this._viewHeight() * 0.5) / strideN;

            this._updateArrowState();
            this.requestRedraw();
            return;
        }

        if (touches.length === 1) {
            const p = this._touchPos(touches[0]);

            if (this._isPinching) {
                this._isPinching = false;
                this._dragSX = p.x;
                this._dragSY = p.y;
                this._lastMouseX = p.x;
                this._lastMouseY = p.y;
                this._moved = true;
                return;
            }

            if (type === 'touchstart') {
                this._stopPanAnimation();
                this._dragSX = p.x;
                this._dragSY = p.y;
                this._lastMouseX = p.x;
                this._lastMouseY = p.y;
                this._moved = false;
                this._dragging = false;
                this._lpFired = false;
                this._startLongPress(p.x, p.y);
                return;
            }

            if (type === 'touchmove') {
                const dx = p.x - this._dragSX;
                const dy = p.y - this._dragSY;
                const dist = Math.hypot(dx, dy);
                if (!this._moved && dist > CLICK_THRESHOLD) {
                    this._moved = true;
                    this._dragging = true;
                    this._cancelLongPress();
                }

                if (this._dragging) {
                    const worldStride = this._stride();
                    if (worldStride > 0) {
                        const mdx = p.x - this._lastMouseX;
                        const mdy = p.y - this._lastMouseY;
                        this.centerX -= mdx / worldStride;
                        this.centerY -= mdy / worldStride;
                        this._updateArrowState();
                        this.requestRedraw();
                    }
                }

                this._lastMouseX = p.x;
                this._lastMouseY = p.y;
            }

            return;
        }

        if (touches.length === 0) {
            this._cancelLongPress();

            if (!this._isPinching && !this._moved && !this._lpFired) {
                const arrowHit = this._hitTestArrow(this._dragSX, this._dragSY);
                if (arrowHit === 'origin') {
                    this.panToOrigin();
                } else if (arrowHit === 'last') {
                    this.panToLastReveal();
                } else {
                    const cell = this._screenToCell(this._dragSX, this._dragSY);
                    if (this.onCellClick) this.onCellClick(cell.x, cell.y, ClickType.LeftClick);
                }
            }

            this._isPinching = false;
            this._dragging = false;
            this._moved = false;
            this._lpFired = false;
            this._cachedRect = null;
        }
    }

    _touchPos(touch) {
        const rect = this._cachedRect || this.canvas.getBoundingClientRect();
        return {
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top,
        };
    }

    _startLongPress(sx, sy) {
        this._cancelLongPress();
        this._lpTimer = setTimeout(() => {
            this._lpTimer = null;
            if (this.inert || this._moved || this._lpFired || this._isPinching) return;
            this._lpFired = true;
            const cell = this._screenToCell(sx, sy);
            if (this.onCellClick) this.onCellClick(cell.x, cell.y, ClickType.LongLeftClick);
        }, LONG_PRESS_MS);
    }

    _cancelLongPress() {
        if (this._lpTimer) {
            clearTimeout(this._lpTimer);
            this._lpTimer = null;
        }
    }
}
