// GridRenderer3D.js — Canvas 2D + 3D projection renderer for 3D Minesweeper
// Port of Client/src/ui/cpp/GridRenderer3D.cpp
// ============================================================================

import { CellContent, CellState, GameState, ClickType, PlayerAction, GameType } from '../../core/CoreEnums.js';
import { getPlayerColorHex, getTeamColorHex } from '../../core/CoreTypes.js';
import { Face } from '../../core/GridManager3D.js';

// ─── Constants ──────────────────────────────────────────────────────────────
const BG_COLOR       = '#222222';
const HIDDEN_CLR     = '#888888';
const REVEAL_CLR     = '#BBBBBB';
const MINE_BG        = '#FF4444';
const CELL_WORLD     = 1.0;
const CELL_SPACING   = 0.06;
const CLICK_THRESHOLD = 8;
const LONG_PRESS_MS  = 300;
const SELECTION_COLOR = 'rgba(255, 230, 120, 0.9)';
const KEYBOARD_ROTATE_SPEED = 160.0;  // degrees per second
const KEYBOARD_ROTATE_INTERVAL = 16;  // ms (~60fps)
const DECAL_TOTAL_MS = 1500;
const DECAL_VISIBLE_MS = 500;
// _zoom is a camera-distance parameter: smaller value = camera closer = looks bigger (zoom in).
// So keyboardZoomIn must DECREASE _zoom (factor < 1) and keyboardZoomOut must INCREASE it.
const KEYBOARD_ZOOM_IN_FACTOR  = 0.9;   // camera moves closer
const KEYBOARD_ZOOM_OUT_FACTOR = 1.1;   // camera pulls back
const ROT_ANIM_DURATION_MS = 300;

function clickThresholdPx() {
    return CLICK_THRESHOLD * (window.devicePixelRatio || 1);
}

const NUMBER_COLORS = [
    '#808080', '#0000FF', '#008000', '#FF0000', '#000080',
    '#800000', '#008080', '#000000', '#808080',
];

function getNumberColor(adj) {
    if (adj >= 0 && adj <= 8) return NUMBER_COLORS[adj];
    return '#CC00CC';
}

// ─── Pre-rendered glyph textures ────────────────────────────────────────────
const _glyphTexCache = new Map();
const GLYPH_TEX_SIZE = 64;

// Shared SVG assets for digital numbers/textures (same paths as GridRenderer.js)
const GRID3D_SVG_ASSETS = {
    n1: 'src/assets/grid/1.svg',  n2: 'src/assets/grid/2.svg',
    n3: 'src/assets/grid/3.svg',  n4: 'src/assets/grid/4.svg',
    n5: 'src/assets/grid/5.svg',  n6: 'src/assets/grid/6.svg',
    n7: 'src/assets/grid/7.svg',  n8: 'src/assets/grid/8.svg',
    flag: 'src/assets/grid/flag.svg',
    mine: 'src/assets/grid/mine.svg',
    wrong: 'src/assets/grid/wrong_flag.svg',
    exploded: 'src/assets/grid/mine_exploded.svg',
};
const _spriteImages3D = new Map();
let _spriteImages3DLoaded = false;

function _ensureSprites3DLoaded(onUpdate) {
    if (_spriteImages3DLoaded) return;
    _spriteImages3DLoaded = true;
    for (const [key, src] of Object.entries(GRID3D_SVG_ASSETS)) {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => { _glyphTexCache.clear(); if (onUpdate) onUpdate(); };
        img.src = src;
        _spriteImages3D.set(key, img);
    }
}

function _getSpriteKey(glyph, digitalNumbers, digitalTextures) {
    if (digitalTextures) {
        if (glyph === '🚩') return 'flag';
        if (glyph === '💣') return 'mine';
        if (glyph === '❌') return 'wrong';
        if (glyph === '💥') return 'exploded';
    }
    if (digitalNumbers) {
        const n = parseInt(glyph);
        if (n >= 1 && n <= 8) return `n${n}`;
    }
    return null;
}

function _getGlyphTex(glyph, color, digitalNumbers, digitalTextures) {
    const key = glyph + '|' + color + (digitalNumbers ? '|dn' : '') + (digitalTextures ? '|dt' : '');
    let tex = _glyphTexCache.get(key);
    if (tex) return tex;

    const cv = document.createElement('canvas');
    cv.width = GLYPH_TEX_SIZE;
    cv.height = GLYPH_TEX_SIZE;
    const c = cv.getContext('2d');
    const s = GLYPH_TEX_SIZE;

    // Try SVG sprite first when digital settings are active
    const spriteKey = _getSpriteKey(glyph, digitalNumbers, digitalTextures);
    if (spriteKey) {
        const img = _spriteImages3D.get(spriteKey);
        if (img && img.complete && img.naturalWidth > 0) {
            const pad = s * 0.1;
            c.drawImage(img, pad, pad, s - pad * 2, s - pad * 2);
            _glyphTexCache.set(key, cv);
            return cv;
        }
        // SVG not loaded yet — fall through to text glyph (will re-cache once loaded)
    }

    if (glyph === '🚩' || glyph === '💣' || glyph === '❌') {
        c.font = `${s * 0.7}px sans-serif`;
    } else {
        c.font = `bold ${s * 0.78}px sans-serif`;
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = color;
    c.fillText(glyph, s / 2, s / 2);

    // Only cache if we didn't want a sprite (or sprite wasn't ready — don't cache)
    if (!spriteKey) _glyphTexCache.set(key, cv);
    return cv;
}

function getCellColor(gm, addr, cell) {
    const owner = cell.state === CellState.Flagged
        ? gm.flagOwner?.(addr)
        : gm.revealOwner?.(addr);
    if (owner !== undefined && owner >= 0) return getTeamColorHex(owner);
    if (cell.state === CellState.Revealed) return REVEAL_CLR;
    return HIDDEN_CLR;
}

function getCellGlyph(cell, paintFalseFlags, paintAllMines) {
    if (cell.state === CellState.Flagged)
        return (paintFalseFlags && cell.content === CellContent.Safe) ? '❌' : '🚩';
    if (cell.state === CellState.Revealed) {
        if (cell.content === CellContent.Mine) return '💥';
        if (cell.adj > 0) return String(cell.adj);
    }
    if (paintAllMines && cell.content === CellContent.Mine) return '💣';
    return null;
}

// ─── Simple Vec3 / Mat4 helpers ─────────────────────────────────────────────
function v3(x, y, z) { return { x, y, z }; }

function v3add(a, b)      { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function v3sub(a, b)      { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function v3scale(a, s)    { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function v3dot(a, b)      { return a.x * b.x + a.y * b.y + a.z * b.z; }
function v3len(a)         { return Math.sqrt(v3dot(a, a)); }
function v3norm(a)        { const l = v3len(a); return l > 0 ? v3scale(a, 1/l) : a; }

// 4x4 matrix as Float64Array[16], column-major (like OpenGL)
function mat4Identity() {
    const m = new Float64Array(16);
    m[0]=1; m[5]=1; m[10]=1; m[15]=1;
    return m;
}
function mat4Mult(a, b) {
    const r = new Float64Array(16);
    for (let c = 0; c < 4; c++)
        for (let rw = 0; rw < 4; rw++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[rw + k*4] * b[k + c*4];
            r[rw + c*4] = s;
        }
    return r;
}
function mat4Translate(x, y, z) {
    const m = mat4Identity();
    m[12]=x; m[13]=y; m[14]=z;
    return m;
}
function mat4RotateX(deg) {
    const r = deg * Math.PI / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const m = mat4Identity();
    m[5]=c; m[6]=s; m[9]=-s; m[10]=c;
    return m;
}
function mat4RotateY(deg) {
    const r = deg * Math.PI / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const m = mat4Identity();
    m[0]=c; m[2]=-s; m[8]=s; m[10]=c;
    return m;
}
function mat4Perspective(fovDeg, aspect, near, far) {
    const f = 1.0 / Math.tan(fovDeg * Math.PI / 360);
    const nf = 1 / (near - far);
    const m = new Float64Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) * nf; m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
}
function mat4Invert(m) {
    // General 4x4 inverse
    const inv = new Float64Array(16);
    inv[0]  =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15]  + m[9]*m[7]*m[14]  + m[13]*m[6]*m[11]  - m[13]*m[7]*m[10];
    inv[4]  = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15]  - m[8]*m[7]*m[14]  - m[12]*m[6]*m[11]  + m[12]*m[7]*m[10];
    inv[8]  =  m[4]*m[9]*m[15]  - m[4]*m[11]*m[13] - m[8]*m[5]*m[15]  + m[8]*m[7]*m[13]  + m[12]*m[5]*m[11]  - m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9]*m[14]  + m[4]*m[10]*m[13] + m[8]*m[5]*m[14]  - m[8]*m[6]*m[13]  - m[12]*m[5]*m[10]  + m[12]*m[6]*m[9];
    inv[1]  = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15]  - m[9]*m[3]*m[14]  - m[13]*m[2]*m[11]  + m[13]*m[3]*m[10];
    inv[5]  =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15]  + m[8]*m[3]*m[14]  + m[12]*m[2]*m[11]  - m[12]*m[3]*m[10];
    inv[9]  = -m[0]*m[9]*m[15]  + m[0]*m[11]*m[13] + m[8]*m[1]*m[15]  - m[8]*m[3]*m[13]  - m[12]*m[1]*m[11]  + m[12]*m[3]*m[9];
    inv[13] =  m[0]*m[9]*m[14]  - m[0]*m[10]*m[13] - m[8]*m[1]*m[14]  + m[8]*m[2]*m[13]  + m[12]*m[1]*m[10]  - m[12]*m[2]*m[9];
    inv[2]  =  m[1]*m[6]*m[15]  - m[1]*m[7]*m[14]  - m[5]*m[2]*m[15]  + m[5]*m[3]*m[14]  + m[13]*m[2]*m[7]   - m[13]*m[3]*m[6];
    inv[6]  = -m[0]*m[6]*m[15]  + m[0]*m[7]*m[14]  + m[4]*m[2]*m[15]  - m[4]*m[3]*m[14]  - m[12]*m[2]*m[7]   + m[12]*m[3]*m[6];
    inv[10] =  m[0]*m[5]*m[15]  - m[0]*m[7]*m[13]  - m[4]*m[1]*m[15]  + m[4]*m[3]*m[13]  + m[12]*m[1]*m[7]   - m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5]*m[14]  + m[0]*m[6]*m[13]  + m[4]*m[1]*m[14]  - m[4]*m[2]*m[13]  - m[12]*m[1]*m[6]   + m[12]*m[2]*m[5];
    inv[3]  = -m[1]*m[6]*m[11]  + m[1]*m[7]*m[10]  + m[5]*m[2]*m[11]  - m[5]*m[3]*m[10]  - m[9]*m[2]*m[7]    + m[9]*m[3]*m[6];
    inv[7]  =  m[0]*m[6]*m[11]  - m[0]*m[7]*m[10]  - m[4]*m[2]*m[11]  + m[4]*m[3]*m[10]  + m[8]*m[2]*m[7]    - m[8]*m[3]*m[6];
    inv[11] = -m[0]*m[5]*m[11]  + m[0]*m[7]*m[9]   + m[4]*m[1]*m[11]  - m[4]*m[3]*m[9]   - m[8]*m[1]*m[7]    + m[8]*m[3]*m[5];
    inv[15] =  m[0]*m[5]*m[10]  - m[0]*m[6]*m[9]   - m[4]*m[1]*m[10]  + m[4]*m[2]*m[9]   + m[8]*m[1]*m[6]    - m[8]*m[2]*m[5];

    let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (Math.abs(det) < 1e-12) return null;
    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
}
function mat4TransformVec4(m, x, y, z, w) {
    return {
        x: m[0]*x + m[4]*y + m[8]*z  + m[12]*w,
        y: m[1]*x + m[5]*y + m[9]*z  + m[13]*w,
        z: m[2]*x + m[6]*y + m[10]*z + m[14]*w,
        w: m[3]*x + m[7]*y + m[11]*z + m[15]*w,
    };
}

// ─── Face vertex helpers ────────────────────────────────────────────────────

function lerpPt(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function getFaceVertices(gm) {
    const hw = gm.w * CELL_WORLD * 0.5;
    const hh = gm.h * CELL_WORLD * 0.5;
    const hl = gm.l * CELL_WORLD * 0.5;
    return [
        /* Front  */ { tl: v3(-hw,-hh, hl), tr: v3( hw,-hh, hl), bl: v3(-hw, hh, hl), br: v3( hw, hh, hl) },
        /* Back   */ { tl: v3( hw,-hh,-hl), tr: v3(-hw,-hh,-hl), bl: v3( hw, hh,-hl), br: v3(-hw, hh,-hl) },
        /* Left   */ { tl: v3(-hw,-hh,-hl), tr: v3(-hw,-hh, hl), bl: v3(-hw, hh,-hl), br: v3(-hw, hh, hl) },
        /* Right  */ { tl: v3( hw,-hh, hl), tr: v3( hw,-hh,-hl), bl: v3( hw, hh, hl), br: v3( hw, hh,-hl) },
        /* Top    */ { tl: v3(-hw,-hh,-hl), tr: v3( hw,-hh,-hl), bl: v3(-hw,-hh, hl), br: v3( hw,-hh, hl) },
        /* Bottom */ { tl: v3(-hw, hh, hl), tr: v3( hw, hh, hl), bl: v3(-hw, hh,-hl), br: v3( hw, hh,-hl) },
    ];
}

const FACE_NORMALS = [
    v3( 0, 0, 1), v3( 0, 0,-1), v3(-1, 0, 0),
    v3( 1, 0, 0), v3( 0,-1, 0), v3( 0, 1, 0),
];

// ═══════════════════════════════════════════════════════════════════════════
// GridRenderer3D
// ═══════════════════════════════════════════════════════════════════════════

export class GridRenderer3D {
    constructor(canvas) {
        this._canvas = canvas;
        this._ctx = canvas.getContext('2d');
        this._gm = null;
        this._inert = false;
        this._paintFalseFlags = false;
        this._paintAllMines = false;

        // Camera state
        this._rotX = -25;
        this._rotY = 35;
        this._zoom = 8;
        this._minZoom = 2;
        this._maxZoom = 30;

        // Rotation animation state
        this._rotAnimRafId = null;
        this._rotXAnimStart = 0;
        this._rotYAnimStart = 0;
        this._rotXAnimTarget = 0;
        this._rotYAnimTarget = 0;
        this._rotAnimStartTime = 0;

        // Input state
        this._dragging = false;
        this._dragStart = null;
        this._dragRotXStart = 0;
        this._dragRotYStart = 0;
        this._hasMoved = false;
        this._longPressTimer = null;
        this._longPressTriggered = false;
        this._isRightClick = false;
        this._isPinching = false;
        this._pinchStartDist = 0;
        this._pinchStartZoom = 0;
        this._lastTouches = [];

        // Keyboard selection state
        this._hasKeyboardSelection = false;
        this._selectedFace = -1;
        this._selectedRow = -1;
        this._selectedCol = -1;

        // Keyboard rotation state (Shift + Arrow keys)
        this._shiftHeld = false;
        this._arrowHeldLeft = false;
        this._arrowHeldRight = false;
        this._arrowHeldUp = false;
        this._arrowHeldDown = false;
        this._keyboardRotateTimer = null;
        this._keyboardRotateLastTime = 0;

        // Digital settings (matching GridRenderer API)
        this._digitalNumbersEnabled  = false;
        this._digitalTexturesEnabled = false;
        this._decals = [];
        this._showDecals = true;

        // Callbacks
        this.onCellClick = null;  // (face, row, col, clickType)

        this._dirty = true;
        this._rafId = null;

        _ensureSprites3DLoaded(() => { this._dirty = true; });

        this._setupInput();
        this._startRenderLoop();
    }

    setGridManager(gm) {
        this._resetInteractionState({ resetKeyboard: true });
        this._gm = gm;
        this._paintFalseFlags = false;
        this._paintAllMines = false;
        this._hasKeyboardSelection = false;
        this._selectedFace = -1;
        this._selectedRow = -1;
        this._selectedCol = -1;
        if (gm) {
            this._computeZoomLimits();
            this._resetView();
        }
        this._dirty = true;
    }

    setInert(inert) {
        this._inert = inert;
        if (!inert) {
            this._paintFalseFlags = false;
            this._paintAllMines = false;
        }
        if (inert) this._resetInteractionState({ resetKeyboard: true });
    }

    setDigitalNumbersEnabled(enabled) {
        const normalized = !!enabled;
        if (this._digitalNumbersEnabled === normalized) return;
        this._digitalNumbersEnabled = normalized;
        _glyphTexCache.clear();
        this._dirty = true;
    }

    setDigitalTexturesEnabled(enabled) {
        const normalized = !!enabled;
        if (this._digitalTexturesEnabled === normalized) return;
        this._digitalTexturesEnabled = normalized;
        _glyphTexCache.clear();
        this._dirty = true;
    }

    _clearLongPressTimer() {
        if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
    }

    _resetPointerInteractionState() {
        this._clearLongPressTimer();
        this._dragging = false;
        this._dragStart = null;
        this._hasMoved = false;
        this._longPressTriggered = false;
        this._isRightClick = false;
        this._isPinching = false;
        this._pinchStartDist = 0;
        this._pinchStartZoom = 0;
        this._lastTouches = [];
    }

    _resetKeyboardRotateState() {
        this._shiftHeld = false;
        this._arrowHeldLeft = false;
        this._arrowHeldRight = false;
        this._arrowHeldUp = false;
        this._arrowHeldDown = false;
        this._stopKeyboardRotate();
    }

    _resetInteractionState({ resetKeyboard = false } = {}) {
        this._resetPointerInteractionState();
        if (resetKeyboard) this._resetKeyboardRotateState();
    }

    revealFalseFlags() {
        this._paintFalseFlags = true;
        this._dirty = true;
    }

    revealAllMines() {
        this._paintAllMines = true;
        this._dirty = true;
    }

    clearRevealOverlays() {
        this._paintFalseFlags = false;
        this._paintAllMines = false;
        this._dirty = true;
    }

    addDecal(face, row, col, action, playerID, playerName, ownPlayerID,
             gameType = GameType.CoOpHard) {
        if (playerID === ownPlayerID || !this._showDecals) return;
        this._decals.push({
            face,
            row,
            col,
            playerID,
            gameType,
            name: playerName || '',
            isFlag: action === PlayerAction.FlagSet || action === PlayerAction.FlagClear,
            t: performance.now(),
        });
        this._dirty = true;
    }

    show() { this._canvas.style.display = ''; this._inert = false; this._dirty = true; }
    hide() {
        this._canvas.style.display = 'none';
        this._inert = true;
        this._hasKeyboardSelection = false;
        this._resetInteractionState({ resetKeyboard: true });
    }

    // ────────────────────────────────────────────────────────────────────────
    // Camera
    // ────────────────────────────────────────────────────────────────────────

    _resetView() {
        if (this._rotAnimRafId) {
            cancelAnimationFrame(this._rotAnimRafId);
            this._rotAnimRafId = null;
        }
        this._rotX = -25;
        this._rotY = 35;
        this._computeZoomLimits();
        this._zoom = this._minZoom * 1.8;
    }

    focusCell(face, row, col) {
        if (!this._gm) return;
        const addr = { face, row, col };
        if (!this._gm.isValidCell(addr)) return;

        const center = this._cellCenterWorld(face, row, col);
        if (!center) return;

        const horizontalLen = Math.hypot(center.x, center.z);
        if (horizontalLen <= 1e-6 && Math.abs(center.y) <= 1e-6) return;

        const targetRotX = Math.max(-89, Math.min(89, Math.atan2(center.y, horizontalLen) * 180 / Math.PI));
        const rawRotY    = Math.atan2(-center.x, center.z) * 180 / Math.PI;

        // Shortest arc for Y so we never spin the wrong way
        let deltaY = rawRotY - this._rotY;
        while (deltaY >  180) deltaY -= 360;
        while (deltaY < -180) deltaY += 360;

        this._rotXAnimStart  = this._rotX;
        this._rotYAnimStart  = this._rotY;
        this._rotXAnimTarget = targetRotX;
        this._rotYAnimTarget = this._rotY + deltaY;
        this._rotAnimStartTime = performance.now();

        if (!this._rotAnimRafId) {
            this._rotAnimRafId = requestAnimationFrame(() => this._stepRotAnim());
        }
    }

    _stepRotAnim() {
        this._rotAnimRafId = null;
        const elapsed = performance.now() - this._rotAnimStartTime;

        if (elapsed >= ROT_ANIM_DURATION_MS) {
            this._rotX = this._rotXAnimTarget;
            this._rotY = this._rotYAnimTarget;
            this._dirty = true;
            return;
        }

        const t     = elapsed / ROT_ANIM_DURATION_MS;
        const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
        this._rotX  = this._rotXAnimStart + (this._rotXAnimTarget - this._rotXAnimStart) * eased;
        this._rotY  = this._rotYAnimStart + (this._rotYAnimTarget - this._rotYAnimStart) * eased;
        this._dirty = true;
        this._rotAnimRafId = requestAnimationFrame(() => this._stepRotAnim());
    }

    _computeZoomLimits() {
        if (!this._gm) return;
        const w = this._gm.w * CELL_WORLD;
        const h = this._gm.h * CELL_WORLD;
        const l = this._gm.l * CELL_WORLD;
        const maxDiag = Math.sqrt(w*w + h*h + l*l);
        this._minZoom = maxDiag * 0.55;
        this._maxZoom = maxDiag * 4.0;
        this._zoom = Math.max(this._minZoom, Math.min(this._zoom, this._maxZoom));
    }

    // ────────────────────────────────────────────────────────────────────────
    // Projection
    // ────────────────────────────────────────────────────────────────────────

    _viewProjectionMatrix() {
        const view = mat4Mult(
            mat4Mult(mat4Translate(0, 0, -this._zoom), mat4RotateX(this._rotX)),
            mat4RotateY(this._rotY)
        );
        const aspect = this._canvas.width / Math.max(this._canvas.height, 1);
        const proj = mat4Perspective(45, aspect, 0.1, this._zoom * 4);
        return mat4Mult(proj, view);
    }

    _project(worldPos, vp) {
        const clip = mat4TransformVec4(vp, worldPos.x, worldPos.y, worldPos.z, 1);
        if (Math.abs(clip.w) < 1e-7) return null;
        const ndcX = clip.x / clip.w;
        const ndcY = clip.y / clip.w;
        // Y-down world: no NDC Y-flip needed
        return {
            x: (ndcX + 1) * 0.5 * this._canvas.width,
            y: (ndcY + 1) * 0.5 * this._canvas.height,
        };
    }

    _cameraWorldPos() {
        const invRot = mat4Mult(mat4RotateY(-this._rotY), mat4RotateX(-this._rotX));
        const p = mat4TransformVec4(invRot, 0, 0, this._zoom, 1);
        return v3(p.x, p.y, p.z);
    }

    _isFaceVisible(face) {
        if (!this._gm) return false;
        const cam = this._cameraWorldPos();
        const fvs = getFaceVertices(this._gm);
        const fv = fvs[face];
        const center = v3scale(v3add(v3add(fv.tl, fv.tr), v3add(fv.bl, fv.br)), 0.25);
        const toCam = v3sub(cam, center);
        return v3dot(FACE_NORMALS[face], toCam) > 0;
    }

    _cellCenterWorld(face, row, col) {
        if (!this._gm) return null;
        const addr = { face, row, col };
        if (!this._gm.isValidCell(addr)) return null;

        const rows = this._gm.faceRows(face);
        const cols = this._gm.faceCols(face);
        if (rows <= 0 || cols <= 0) return null;

        const fvs = getFaceVertices(this._gm);
        const fv = fvs[face];
        const rightVec = v3sub(fv.tr, fv.tl);
        const downVec = v3sub(fv.bl, fv.tl);
        const u = (col + 0.5) / cols;
        const v = (row + 0.5) / rows;
        return v3add(fv.tl, v3add(v3scale(rightVec, u), v3scale(downVec, v)));
    }

    // ────────────────────────────────────────────────────────────────────────
    // Hit testing
    // ────────────────────────────────────────────────────────────────────────

    _hitTest(screenX, screenY) {
        if (!this._gm) return null;
        const vp = this._viewProjectionMatrix();
        const cam = this._cameraWorldPos();

        // Unproject screen to NDC (Y-down: no flip)
        const ndcX = (screenX / this._canvas.width) * 2 - 1;
        const ndcY = (screenY / this._canvas.height) * 2 - 1;

        const invVP = mat4Invert(vp);
        if (!invVP) return null;

        const near = mat4TransformVec4(invVP, ndcX, ndcY, -1, 1);
        const far  = mat4TransformVec4(invVP, ndcX, ndcY,  1, 1);
        if (Math.abs(near.w) < 1e-7 || Math.abs(far.w) < 1e-7) return null;

        const rayOrigin = v3(near.x/near.w, near.y/near.w, near.z/near.w);
        const rayEnd    = v3(far.x/far.w, far.y/far.w, far.z/far.w);
        const rayDir    = v3norm(v3sub(rayEnd, rayOrigin));

        const fvs = getFaceVertices(this._gm);
        let bestHit = null;
        let bestDist = 1e30;

        for (let f = 0; f < Face.FaceCount; f++) {
            if (!this._isFaceVisible(f)) continue;

            const normal = FACE_NORMALS[f];
            const fv = fvs[f];
            const planePoint = v3scale(v3add(fv.tl, fv.br), 0.5);
            const denom = v3dot(normal, rayDir);
            if (Math.abs(denom) < 1e-7) continue;

            const t = v3dot(v3sub(planePoint, rayOrigin), normal) / denom;
            if (t < 0 || t >= bestDist) continue;

            const hitPoint = v3add(rayOrigin, v3scale(rayDir, t));
            const rightVec = v3sub(fv.tr, fv.tl);
            const downVec  = v3sub(fv.bl, fv.tl);
            const rightLen = v3len(rightVec);
            const downLen  = v3len(downVec);
            if (rightLen < 1e-6 || downLen < 1e-6) continue;

            const local = v3sub(hitPoint, fv.tl);
            const u = v3dot(local, v3scale(rightVec, 1/rightLen)) / rightLen;
            const vv = v3dot(local, v3scale(downVec, 1/downLen)) / downLen;

            if (u < 0 || u > 1 || vv < 0 || vv > 1) continue;

            const rows = this._gm.faceRows(f);
            const cols = this._gm.faceCols(f);
            const col = Math.max(0, Math.min(Math.floor(u * cols), cols - 1));
            const row = Math.max(0, Math.min(Math.floor(vv * rows), rows - 1));

            bestDist = t;
            bestHit = { face: f, row, col };
        }
        return bestHit;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Keyboard zoom
    // ────────────────────────────────────────────────────────────────────────

    keyboardZoomIn() {
        if (!this._gm || this._inert) return;
        this._zoom = Math.max(this._minZoom, Math.min(this._maxZoom, this._zoom * KEYBOARD_ZOOM_IN_FACTOR));
        this._dirty = true;
    }

    keyboardZoomOut() {
        if (!this._gm || this._inert) return;
        this._zoom = Math.max(this._minZoom, Math.min(this._maxZoom, this._zoom * KEYBOARD_ZOOM_OUT_FACTOR));
        this._dirty = true;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Keyboard rotation (Shift + Arrow keys)
    // ────────────────────────────────────────────────────────────────────────

    _anyArrowHeld() {
        return this._arrowHeldLeft || this._arrowHeldRight || this._arrowHeldUp || this._arrowHeldDown;
    }

    _anyRotateKeyPressed() {
        return this._shiftHeld && this._anyArrowHeld();
    }

    _startKeyboardRotate() {
        if (!this._anyRotateKeyPressed()) return;
        this._keyboardRotateLastTime = performance.now();
        if (!this._keyboardRotateTimer) {
            this._keyboardRotateTimer = setInterval(() => this._stepKeyboardRotate(), KEYBOARD_ROTATE_INTERVAL);
        }
    }

    _stopKeyboardRotate() {
        if (this._keyboardRotateTimer) {
            clearInterval(this._keyboardRotateTimer);
            this._keyboardRotateTimer = null;
        }
    }

    _stepKeyboardRotate() {
        if (!this._gm || this._inert || !this._anyRotateKeyPressed()) {
            this._stopKeyboardRotate();
            return;
        }

        const now = performance.now();
        const elapsedMs = now - this._keyboardRotateLastTime;
        this._keyboardRotateLastTime = now;
        const dt = Math.min(Math.max(elapsedMs / 1000.0, 0), 0.05);
        if (dt <= 0) return;

        let dirX = 0, dirY = 0;
        if (this._arrowHeldLeft) dirX -= 1;
        if (this._arrowHeldRight) dirX += 1;
        if (this._arrowHeldUp) dirY -= 1;
        if (this._arrowHeldDown) dirY += 1;

        if (dirX === 0 && dirY === 0) return;

        this._rotY -= dirX * KEYBOARD_ROTATE_SPEED * dt;
        this._rotX = Math.max(-89, Math.min(89, this._rotX + dirY * KEYBOARD_ROTATE_SPEED * dt));
        this._dirty = true;
    }

    _setArrowHeldState(key, pressed) {
        switch (key) {
        case 'ArrowLeft':  this._arrowHeldLeft = pressed; break;
        case 'ArrowRight': this._arrowHeldRight = pressed; break;
        case 'ArrowUp':    this._arrowHeldUp = pressed; break;
        case 'ArrowDown':  this._arrowHeldDown = pressed; break;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Keyboard cell selection
    // ────────────────────────────────────────────────────────────────────────

    _ensureKeyboardSelection() {
        if (!this._gm) {
            this._hasKeyboardSelection = false;
            this._selectedFace = -1;
            this._selectedRow = -1;
            this._selectedCol = -1;
            return false;
        }

        const selected = { face: this._selectedFace, row: this._selectedRow, col: this._selectedCol };
        if (this._gm.isValidCell(selected)) {
            if (!this._hasKeyboardSelection) {
                this._hasKeyboardSelection = true;
                this._dirty = true;
            }
            return true;
        }

        // Try to find the cell at screen center
        const dpr = window.devicePixelRatio || 1;
        const rect = this._canvas.getBoundingClientRect();
        const centerHit = this._hitTest(rect.width * dpr * 0.5, rect.height * dpr * 0.5);
        let initial;
        if (centerHit) {
            initial = { face: centerHit.face, row: centerHit.row, col: centerHit.col };
        } else {
            const fallbackFace = Face.Front;
            const rows = this._gm.faceRows(fallbackFace);
            const cols = this._gm.faceCols(fallbackFace);
            if (rows <= 0 || cols <= 0) {
                this._hasKeyboardSelection = false;
                this._selectedFace = -1;
                this._selectedRow = -1;
                this._selectedCol = -1;
                return false;
            }
            initial = { face: fallbackFace, row: Math.floor(rows / 2), col: Math.floor(cols / 2) };
        }

        if (!this._gm.isValidCell(initial)) return false;

        this._hasKeyboardSelection = true;
        this._selectedFace = initial.face;
        this._selectedRow = initial.row;
        this._selectedCol = initial.col;
        this._dirty = true;
        return true;
    }

    _moveKeyboardSelection(dRow, dCol) {
        if (!this._ensureKeyboardSelection()) return;

        const face = this._selectedFace;
        const nextRow = this._selectedRow + dRow;
        const nextCol = this._selectedCol + dCol;
        let target = { face, row: nextRow, col: nextCol };

        if (!this._gm.isValidCell(target)) {
            const rowOut = (nextRow < 0 || nextRow >= this._gm.faceRows(face));
            const colOut = (nextCol < 0 || nextCol >= this._gm.faceCols(face));
            if (rowOut !== colOut) {
                target = this._gm.mapOffFace(face, nextRow, nextCol);
            }
        }

        if (!this._gm.isValidCell(target)) return;

        this._hasKeyboardSelection = true;
        this._selectedFace = target.face;
        this._selectedRow = target.row;
        this._selectedCol = target.col;
        this._dirty = true;
    }

    _moveKeyboardSelectionByPovArrow(key) {
        if (!this._ensureKeyboardSelection()) return false;
        if (this._selectedFace !== Face.Top && this._selectedFace !== Face.Bottom) return false;

        let desiredDir;
        switch (key) {
        case 'ArrowLeft':  desiredDir = { x: -1, y: 0 }; break;
        case 'ArrowRight': desiredDir = { x: 1, y: 0 }; break;
        case 'ArrowUp':    desiredDir = { x: 0, y: -1 }; break;
        case 'ArrowDown':  desiredDir = { x: 0, y: 1 }; break;
        default: return false;
        }

        const vp = this._viewProjectionMatrix();
        const fvs = getFaceVertices(this._gm);
        const fv = fvs[this._selectedFace];
        const faceCenter = v3scale(v3add(v3add(fv.tl, fv.tr), v3add(fv.bl, fv.br)), 0.25);

        let rightDir = v3sub(fv.tr, fv.tl);
        let downDir = v3sub(fv.bl, fv.tl);
        const rightLen = v3len(rightDir);
        const downLen = v3len(downDir);
        if (rightLen <= 1e-6 || downLen <= 1e-6) return false;
        rightDir = v3scale(rightDir, 1 / rightLen);
        downDir = v3scale(downDir, 1 / downLen);

        const sampleDist = 0.25;
        const screenCenter = this._project(faceCenter, vp);
        const screenRight = this._project(v3add(faceCenter, v3scale(rightDir, sampleDist)), vp);
        const screenDown = this._project(v3add(faceCenter, v3scale(downDir, sampleDist)), vp);
        if (!screenCenter || !screenRight || !screenDown) return false;

        const vrx = screenRight.x - screenCenter.x;
        const vry = screenRight.y - screenCenter.y;
        const vdx = screenDown.x - screenCenter.x;
        const vdy = screenDown.y - screenCenter.y;

        const candidates = [
            { dRow: -1, dCol: 0, vx: -vdx, vy: -vdy },
            { dRow: 1,  dCol: 0, vx: vdx,  vy: vdy },
            { dRow: 0,  dCol: -1, vx: -vrx, vy: -vry },
            { dRow: 0,  dCol: 1, vx: vrx,  vy: vry },
        ];

        let found = false;
        let bestScore = -2;
        let bestDRow = 0, bestDCol = 0;
        for (const c of candidates) {
            const len = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
            if (len <= 1e-6) continue;
            const score = (c.vx / len) * desiredDir.x + (c.vy / len) * desiredDir.y;
            if (!found || score > bestScore) {
                found = true;
                bestScore = score;
                bestDRow = c.dRow;
                bestDCol = c.dCol;
            }
        }

        if (!found) return false;
        this._moveKeyboardSelection(bestDRow, bestDCol);
        return true;
    }

    _triggerKeyboardAction(clickType) {
        if (!this._ensureKeyboardSelection()) return;
        if (this.onCellClick) {
            this.onCellClick(this._selectedFace, this._selectedRow, this._selectedCol, clickType);
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Glyph rotation for Top/Bottom POV
    // ────────────────────────────────────────────────────────────────────────

    _glyphQuarterTurnsForPov(face, vp) {
        if (!this._gm || (face !== Face.Top && face !== Face.Bottom)) return 0;

        const fvs = getFaceVertices(this._gm);
        const fv = fvs[face];
        const faceCenter = v3scale(v3add(v3add(fv.tl, fv.tr), v3add(fv.bl, fv.br)), 0.25);

        let rightDir = v3sub(fv.tr, fv.tl);
        let downDir = v3sub(fv.bl, fv.tl);
        const rightLen = v3len(rightDir);
        const downLen = v3len(downDir);
        if (rightLen <= 1e-6 || downLen <= 1e-6) return 0;
        rightDir = v3scale(rightDir, 1 / rightLen);
        downDir = v3scale(downDir, 1 / downLen);

        const sampleDist = 0.25;
        const screenCenter = this._project(faceCenter, vp);
        const screenRight = this._project(v3add(faceCenter, v3scale(rightDir, sampleDist)), vp);
        const screenDown = this._project(v3add(faceCenter, v3scale(downDir, sampleDist)), vp);
        if (!screenCenter || !screenRight || !screenDown) return 0;

        const vrx = screenRight.x - screenCenter.x;
        const vry = screenRight.y - screenCenter.y;
        const vdx = screenDown.x - screenCenter.x;
        const vdy = screenDown.y - screenCenter.y;
        const vrLen = Math.sqrt(vrx * vrx + vry * vry);
        const vdLen = Math.sqrt(vdx * vdx + vdy * vdy);
        if (vrLen <= 1e-6 || vdLen <= 1e-6) return 0;

        const rnx = vrx / vrLen, rny = vry / vrLen;
        const dnx = vdx / vdLen, dny = vdy / vdLen;

        const rotations = [
            { rightX: rnx, rightY: rny, downX: dnx, downY: dny },
            { rightX: -dnx, rightY: -dny, downX: rnx, downY: rny },
            { rightX: -rnx, rightY: -rny, downX: -dnx, downY: -dny },
            { rightX: dnx, rightY: dny, downX: -rnx, downY: -rny },
        ];

        let bestTurns = 0, bestScore = -10;
        for (let i = 0; i < rotations.length; i++) {
            const a = rotations[i];
            const downAlign = a.downY;  // dot with (0,1)
            const rightAlign = a.rightX; // dot with (1,0)
            const score = downAlign + rightAlign * 0.25;
            if (score > bestScore) {
                bestScore = score;
                bestTurns = i;
            }
        }
        return bestTurns;
    }

    _rotateProjectedQuadCW(quad, quarterTurnsCW) {
        const turns = ((quarterTurnsCW % 4) + 4) % 4;
        switch (turns) {
        case 1: return [quad[2], quad[0], quad[3], quad[1]];
        case 2: return [quad[3], quad[2], quad[1], quad[0]];
        case 3: return [quad[1], quad[3], quad[0], quad[2]];
        default: return quad;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Rendering
    // ────────────────────────────────────────────────────────────────────────

    _startRenderLoop() {
        const loop = () => {
            this._rafId = requestAnimationFrame(loop);
            if (this._dirty) {
                this._dirty = false;
                this._render();
            }
        };
        loop();
    }

    _render() {
        const canvas = this._canvas;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width  = rect.width * dpr;
        canvas.height = rect.height * dpr;

        const ctx = this._ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Background
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, rect.width, rect.height);

        const gm = this._gm;
        if (!gm || gm.gameState === GameState.Uninitialized) return;

        // Reset transform for pixel coords (use canvas pixel size)
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        const vp = this._viewProjectionMatrix();
        const cam = this._cameraWorldPos();
        const fvs = getFaceVertices(gm);

        // Sort faces back-to-front (painter's algorithm)
        const faceOrder = [];
        for (let f = 0; f < Face.FaceCount; f++) {
            if (!this._isFaceVisible(f)) continue;
            const fv = fvs[f];
            const center = v3scale(v3add(v3add(fv.tl, fv.tr), v3add(fv.bl, fv.br)), 0.25);
            const dist = v3dot(v3sub(cam, center), v3sub(cam, center));
            faceOrder.push({ face: f, dist });
        }
        faceOrder.sort((a, b) => b.dist - a.dist);

        for (const fo of faceOrder) {
            const f = fo.face;
            const rows = gm.faceRows(f);
            const cols = gm.faceCols(f);
            const fv = fvs[f];
            const rightVec = v3sub(fv.tr, fv.tl);
            const downVec  = v3sub(fv.bl, fv.tl);
            const glyphQuarterTurns = this._glyphQuarterTurnsForPov(f, vp);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const cell = gm.faces[f][r][c];

                    const u0 = (c + CELL_SPACING * 0.5) / cols;
                    const u1 = (c + 1 - CELL_SPACING * 0.5) / cols;
                    const v0 = (r + CELL_SPACING * 0.5) / rows;
                    const v1 = (r + 1 - CELL_SPACING * 0.5) / rows;

                    const tl3 = v3add(fv.tl, v3add(v3scale(rightVec, u0), v3scale(downVec, v0)));
                    const tr3 = v3add(fv.tl, v3add(v3scale(rightVec, u1), v3scale(downVec, v0)));
                    const bl3 = v3add(fv.tl, v3add(v3scale(rightVec, u0), v3scale(downVec, v1)));
                    const br3 = v3add(fv.tl, v3add(v3scale(rightVec, u1), v3scale(downVec, v1)));

                    const pTL = this._project(tl3, vp);
                    const pTR = this._project(tr3, vp);
                    const pBL = this._project(bl3, vp);
                    const pBR = this._project(br3, vp);
                    if (!pTL || !pTR || !pBL || !pBR) continue;

                    // Draw cell quad
                    ctx.fillStyle = getCellColor(gm, { face: f, row: r, col: c }, cell);
                    ctx.beginPath();
                    ctx.moveTo(pTL.x, pTL.y);
                    ctx.lineTo(pTR.x, pTR.y);
                    ctx.lineTo(pBR.x, pBR.y);
                    ctx.lineTo(pBL.x, pBL.y);
                    ctx.closePath();
                    ctx.fill();

                    // Draw selection border for keyboard-selected cell
                    if (this._hasKeyboardSelection && f === this._selectedFace && r === this._selectedRow && c === this._selectedCol) {
                        const edgeTop = Math.sqrt((pTR.x - pTL.x) ** 2 + (pTR.y - pTL.y) ** 2);
                        const edgeLeft = Math.sqrt((pBL.x - pTL.x) ** 2 + (pBL.y - pTL.y) ** 2);
                        const minEdge = Math.max(1, Math.min(edgeTop, edgeLeft));
                        const borderFrac = Math.max(0.03, Math.min(2 / minEdge, 0.30));

                        ctx.fillStyle = SELECTION_COLOR;
                        // Top border
                        const tiTL = lerpPt(pTL, pBL, borderFrac);
                        const tiTR = lerpPt(pTR, pBR, borderFrac);
                        ctx.beginPath();
                        ctx.moveTo(pTL.x, pTL.y); ctx.lineTo(pTR.x, pTR.y);
                        ctx.lineTo(tiTR.x, tiTR.y); ctx.lineTo(tiTL.x, tiTL.y);
                        ctx.closePath(); ctx.fill();
                        // Bottom border
                        const biBL = lerpPt(pBL, pTL, borderFrac);
                        const biBR = lerpPt(pBR, pTR, borderFrac);
                        ctx.beginPath();
                        ctx.moveTo(biBL.x, biBL.y); ctx.lineTo(biBR.x, biBR.y);
                        ctx.lineTo(pBR.x, pBR.y); ctx.lineTo(pBL.x, pBL.y);
                        ctx.closePath(); ctx.fill();
                        // Left border
                        const liTL = lerpPt(pTL, pTR, borderFrac);
                        const liBL = lerpPt(pBL, pBR, borderFrac);
                        ctx.beginPath();
                        ctx.moveTo(pTL.x, pTL.y); ctx.lineTo(liTL.x, liTL.y);
                        ctx.lineTo(liBL.x, liBL.y); ctx.lineTo(pBL.x, pBL.y);
                        ctx.closePath(); ctx.fill();
                        // Right border
                        const riTR = lerpPt(pTR, pTL, borderFrac);
                        const riBR = lerpPt(pBR, pBL, borderFrac);
                        ctx.beginPath();
                        ctx.moveTo(riTR.x, riTR.y); ctx.lineTo(pTR.x, pTR.y);
                        ctx.lineTo(pBR.x, pBR.y); ctx.lineTo(riBR.x, riBR.y);
                        ctx.closePath(); ctx.fill();
                    }

                    // Draw glyph (pre-rendered texture mapped into projected cell quad)
                    const glyph = getCellGlyph(cell, this._paintFalseFlags, this._paintAllMines);
                    if (glyph) {
                        const inset = 0.1;
                        const gu0 = (c + inset) / cols;
                        const gu1 = (c + 1 - inset) / cols;
                        const gv0 = (r + inset) / rows;
                        const gv1 = (r + 1 - inset) / rows;

                        const gTL = this._project(v3add(fv.tl, v3add(v3scale(rightVec, gu0), v3scale(downVec, gv0))), vp);
                        const gTR = this._project(v3add(fv.tl, v3add(v3scale(rightVec, gu1), v3scale(downVec, gv0))), vp);
                        const gBL = this._project(v3add(fv.tl, v3add(v3scale(rightVec, gu0), v3scale(downVec, gv1))), vp);
                        if (gTL && gTR && gBL) {
                            let glyphQuad = [gTL, gTR, gBL];
                            if (glyphQuarterTurns !== 0) {
                                const gBR = this._project(v3add(fv.tl, v3add(v3scale(rightVec, gu1), v3scale(downVec, gv1))), vp);
                                if (gBR) {
                                    const rotated = this._rotateProjectedQuadCW([gTL, gTR, gBL, gBR], glyphQuarterTurns);
                                    glyphQuad = [rotated[0], rotated[1], rotated[2]];
                                }
                            }
                            const dx1 = glyphQuad[1].x - glyphQuad[0].x, dy1 = glyphQuad[1].y - glyphQuad[0].y;
                            const dx2 = glyphQuad[2].x - glyphQuad[0].x, dy2 = glyphQuad[2].y - glyphQuad[0].y;
                            const area = Math.abs(dx1 * dy2 - dx2 * dy1);
                            if (area > 1) {
                                const color = (glyph === '🚩' || glyph === '💣' || glyph === '❌')
                                    ? '#FFFFFF' : getNumberColor(parseInt(glyph));
                                const tex = _getGlyphTex(glyph, color,
                                    this._digitalNumbersEnabled, this._digitalTexturesEnabled);
                                ctx.save();
                                ctx.setTransform(dx1, dy1, dx2, dy2, glyphQuad[0].x, glyphQuad[0].y);
                                ctx.drawImage(tex, 0, 0, 1, 1);
                                ctx.restore();
                            }
                        }
                    }
                }
            }
        }

        if (!this._showDecals && this._decals.length > 0) {
            this._decals.length = 0;
        } else if (this._decals.length > 0) {
            this._drawDecals(ctx, vp);
            this._dirty = true;
        }
    }

    _projectedCellQuad(face, row, col, vp) {
        const gm = this._gm;
        if (!gm) return null;
        const addr = { face, row, col };
        if (!gm.isValidCell(addr)) return null;

        const fvs = getFaceVertices(gm);
        const fv = fvs[face];
        const rows = gm.faceRows(face);
        const cols = gm.faceCols(face);
        const rightVec = v3sub(fv.tr, fv.tl);
        const downVec = v3sub(fv.bl, fv.tl);

        const u0 = (col + CELL_SPACING * 0.5) / cols;
        const u1 = (col + 1 - CELL_SPACING * 0.5) / cols;
        const v0 = (row + CELL_SPACING * 0.5) / rows;
        const v1 = (row + 1 - CELL_SPACING * 0.5) / rows;

        const tl = this._project(v3add(fv.tl, v3add(v3scale(rightVec, u0), v3scale(downVec, v0))), vp);
        const tr = this._project(v3add(fv.tl, v3add(v3scale(rightVec, u1), v3scale(downVec, v0))), vp);
        const bl = this._project(v3add(fv.tl, v3add(v3scale(rightVec, u0), v3scale(downVec, v1))), vp);
        const br = this._project(v3add(fv.tl, v3add(v3scale(rightVec, u1), v3scale(downVec, v1))), vp);
        if (!tl || !tr || !bl || !br) return null;
        return [tl, tr, bl, br];
    }

    _drawDecals(ctx, vp) {
        const now = performance.now();
        let writeIdx = 0;
        for (let i = 0; i < this._decals.length; i++) {
            if (now - this._decals[i].t < DECAL_TOTAL_MS) {
                this._decals[writeIdx++] = this._decals[i];
            }
        }
        this._decals.length = writeIdx;

        for (const d of this._decals) {
            const quad = this._projectedCellQuad(d.face, d.row, d.col, vp);
            if (!quad) continue;

            const elapsed = now - d.t;
            let alpha = 1;
            if (elapsed > DECAL_VISIBLE_MS) {
                alpha = 1 - (elapsed - DECAL_VISIBLE_MS) / (DECAL_TOTAL_MS - DECAL_VISIBLE_MS);
            }
            if (alpha <= 0) continue;

            const [pTL, pTR, pBL, pBR] = quad;
            const edgeTop = Math.hypot(pTR.x - pTL.x, pTR.y - pTL.y);
            const edgeLeft = Math.hypot(pBL.x - pTL.x, pBL.y - pTL.y);
            const minEdge = Math.max(1, Math.min(edgeTop, edgeLeft));
            if (minEdge <= 1) continue;

            const center = {
                x: (pTL.x + pTR.x + pBL.x + pBR.x) / 4,
                y: (pTL.y + pTR.y + pBL.y + pBR.y) / 4,
            };
            const radius = minEdge * 0.18;
            const cx = pBR.x + (center.x - pBR.x) * 0.2;
            const cy = pBR.y + (center.y - pBR.y) * 0.2;

            ctx.globalAlpha = alpha * 0.85;
            ctx.fillStyle = getPlayerColorHex(d.playerID, d.gameType);
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#000';
            ctx.font = `bold ${Math.max(6, Math.floor(radius * 1.4))}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(d.name ? d.name[0].toUpperCase() : '?', cx, cy);

            const iconSize = Math.max(4, Math.floor(radius * 1.2));
            const iconX = cx + radius * 0.55 - iconSize / 2;
            const iconY = cy + radius * 0.55 - iconSize / 2;
            if (d.isFlag) {
                const flagIcon = _spriteImages3D.get('flag');
                if (flagIcon && flagIcon.complete && flagIcon.naturalWidth > 0) {
                    ctx.drawImage(flagIcon, iconX, iconY, iconSize, iconSize);
                }
            } else {
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(iconX + iconSize * 0.5, iconY + iconSize * 0.5,
                    iconSize * 0.18, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        ctx.globalAlpha = 1;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Input handling
    // ────────────────────────────────────────────────────────────────────────

    _getCanvasPos(e) {
        const rect = this._canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return {
            x: (e.clientX - rect.left) * dpr,
            y: (e.clientY - rect.top) * dpr,
        };
    }

    _finishMouseGesture(e, allowClick) {
        const hadActiveGesture = this._dragging || this._dragStart !== null
            || this._isRightClick || this._isPinching || !!this._longPressTimer;
        if (!hadActiveGesture) return;

        const shouldTriggerClick = allowClick && !this._isRightClick
            && !this._hasMoved && !this._longPressTriggered && !this._isPinching;
        const pos = shouldTriggerClick ? this._getCanvasPos(e) : null;

        this._resetPointerInteractionState();

        if (!pos || !this.onCellClick) return;
        const hit = this._hitTest(pos.x, pos.y);
        if (hit) this.onCellClick(hit.face, hit.row, hit.col, ClickType.LeftClick);
    }

    _setupInput() {
        const c = this._canvas;

        // Make canvas focusable for keyboard events
        c.tabIndex = 0;
        c.style.outline = 'none';

        c.addEventListener('mousedown', (e) => {
            if (this._inert) return;
            e.preventDefault();
            c.focus();
            this._resetKeyboardRotateState();
            this._resetPointerInteractionState();
            const pos = this._getCanvasPos(e);
            this._dragging = true;
            this._dragStart = pos;
            this._dragRotXStart = this._rotX;
            this._dragRotYStart = this._rotY;
            this._hasMoved = false;
            this._longPressTriggered = false;
            this._isRightClick = (e.button === 2);

            // Clear keyboard selection on mouse click
            if (this._hasKeyboardSelection) {
                this._hasKeyboardSelection = false;
                this._dirty = true;
            }

            if (this._isRightClick) {
                const hit = this._hitTest(pos.x, pos.y);
                if (hit && this.onCellClick) this.onCellClick(hit.face, hit.row, hit.col, ClickType.RightClick);
            } else {
                this._longPressTimer = setTimeout(() => {
                    if (!this._hasMoved && !this._longPressTriggered && !this._isRightClick && !this._isPinching) {
                        this._longPressTriggered = true;
                        const hit = this._hitTest(this._dragStart.x, this._dragStart.y);
                        if (hit && this.onCellClick) this.onCellClick(hit.face, hit.row, hit.col, ClickType.LongLeftClick);
                    }
                }, LONG_PRESS_MS);
            }
        });

        c.addEventListener('mousemove', (e) => {
            if (!this._dragging || this._inert || this._isRightClick) return;
            if ((e.buttons & 1) === 0) {
                this._resetPointerInteractionState();
                return;
            }
            const pos = this._getCanvasPos(e);
            const dx = pos.x - this._dragStart.x;
            const dy = pos.y - this._dragStart.y;

            if (!this._hasMoved) {
                if (Math.sqrt(dx*dx + dy*dy) > clickThresholdPx()) {
                    this._hasMoved = true;
                    this._clearLongPressTimer();
                }
            }

            if (this._hasMoved) {
                const dpr = window.devicePixelRatio || 1;
                const sensitivity = 0.3 / dpr;
                this._rotY = this._dragRotYStart + dx * sensitivity;
                this._rotX = Math.max(-89, Math.min(89, this._dragRotXStart - dy * sensitivity));
                this._dirty = true;
            }
        });

        c.addEventListener('mouseup', (e) => {
            if (this._inert) return;
            this._finishMouseGesture(e, true);
        });

        this._onDocumentMouseUp = (e) => {
            this._finishMouseGesture(e, e.target === c);
        };
        document.addEventListener('mouseup', this._onDocumentMouseUp, true);

        this._onWindowMouseUp = (e) => {
            this._finishMouseGesture(e, e.target === c);
        };
        window.addEventListener('mouseup', this._onWindowMouseUp);

        c.addEventListener('mouseleave', (e) => {
            if (this._dragging && (e.buttons & 1) === 0) {
                this._resetPointerInteractionState();
            }
        });

        this._onWindowBlur = () => {
            this._resetInteractionState({ resetKeyboard: true });
        };
        window.addEventListener('blur', this._onWindowBlur);

        this._onVisibilityChange = () => {
            if (document.hidden) this._resetInteractionState({ resetKeyboard: true });
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        c.addEventListener('wheel', (e) => {
            if (this._inert) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? 0.9 : 1.1;
            this._zoom = Math.max(this._minZoom, Math.min(this._maxZoom, this._zoom * factor));
            this._dirty = true;
        }, { passive: false });

        c.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard events — attached to document so focus on canvas is not required
        this._onKeyDown = (e) => {
            if (!this._gm || this._inert) return;
            const tag = document.activeElement && document.activeElement.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            const key = e.key;
            const ctrl = e.ctrlKey || e.metaKey;

            // Ctrl + Plus/Equal: zoom in
            if (ctrl && (key === '+' || key === '=')) {
                e.preventDefault();
                this.keyboardZoomIn();
                return;
            }
            // Ctrl + Minus: zoom out
            if (ctrl && (key === '-' || key === '_')) {
                e.preventDefault();
                this.keyboardZoomOut();
                return;
            }

            // Track arrow key held state (not on auto-repeat)
            if (!e.repeat) {
                this._setArrowHeldState(key, true);
            }

            // Shift key
            if (key === 'Shift') {
                this._shiftHeld = true;
                if (this._anyRotateKeyPressed()) this._startKeyboardRotate();
                e.preventDefault();
                return;
            }

            // Shift + Arrow: rotate cube
            const shift = this._shiftHeld || e.shiftKey;
            if (shift && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')) {
                this._shiftHeld = true;
                if (this._anyRotateKeyPressed()) this._startKeyboardRotate();
                e.preventDefault();
                return;
            }

            // Arrow keys: cell navigation
            switch (key) {
            case 'ArrowLeft':
                if (!this._moveKeyboardSelectionByPovArrow('ArrowLeft'))
                    this._moveKeyboardSelection(0, -1);
                e.preventDefault();
                return;
            case 'ArrowRight':
                if (!this._moveKeyboardSelectionByPovArrow('ArrowRight'))
                    this._moveKeyboardSelection(0, 1);
                e.preventDefault();
                return;
            case 'ArrowUp':
                if (!this._moveKeyboardSelectionByPovArrow('ArrowUp'))
                    this._moveKeyboardSelection(-1, 0);
                e.preventDefault();
                return;
            case 'ArrowDown':
                if (!this._moveKeyboardSelectionByPovArrow('ArrowDown'))
                    this._moveKeyboardSelection(1, 0);
                e.preventDefault();
                return;
            case 'f': case 'F':
                this._triggerKeyboardAction(ClickType.RightClick);
                e.preventDefault();
                return;
            case 'r': case 'R':
                this._triggerKeyboardAction(ClickType.LeftClick);
                e.preventDefault();
                return;
            }
        };

        this._onKeyUp = (e) => {
            if (!this._gm || this._inert) return;
            const tag = document.activeElement && document.activeElement.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            const key = e.key;

            if (!e.repeat) {
                this._setArrowHeldState(key, false);
            }

            if (key === 'Shift') {
                this._shiftHeld = false;
                this._stopKeyboardRotate();
                e.preventDefault();
                return;
            }

            if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
                if (!this._anyRotateKeyPressed()) this._stopKeyboardRotate();
                e.preventDefault();
                return;
            }
        };

        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);

        this._onGlobalKeyUp = (e) => {
            if (e.key === 'Shift') this._shiftHeld = false;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                this._setArrowHeldState(e.key, false);
            }
            if (!this._anyRotateKeyPressed()) this._stopKeyboardRotate();
        };
        window.addEventListener('keyup', this._onGlobalKeyUp, true);

        // Touch events
        c.addEventListener('touchstart', (e) => {
            if (this._inert) return;
            e.preventDefault();
            this._resetKeyboardRotateState();
            const touches = e.touches;

            if (touches.length === 2) {
                this._isPinching = true;
                clearTimeout(this._longPressTimer);
                this._pinchStartZoom = this._zoom;
                const dx = touches[1].clientX - touches[0].clientX;
                const dy = touches[1].clientY - touches[0].clientY;
                this._pinchStartDist = Math.max(1, Math.sqrt(dx*dx + dy*dy));
                return;
            }

            if (touches.length === 1) {
                const pos = this._getCanvasPos(touches[0]);
                this._dragging = true;
                this._dragStart = pos;
                this._dragRotXStart = this._rotX;
                this._dragRotYStart = this._rotY;
                this._hasMoved = false;
                this._longPressTriggered = false;
                this._isRightClick = false;

                this._longPressTimer = setTimeout(() => {
                    if (!this._hasMoved && !this._longPressTriggered && !this._isPinching) {
                        this._longPressTriggered = true;
                        const hit = this._hitTest(this._dragStart.x, this._dragStart.y);
                        if (hit && this.onCellClick) this.onCellClick(hit.face, hit.row, hit.col, ClickType.LongLeftClick);
                    }
                }, LONG_PRESS_MS);
            }
        }, { passive: false });

        c.addEventListener('touchmove', (e) => {
            if (this._inert) return;
            e.preventDefault();
            const touches = e.touches;

            if (touches.length === 2 && this._isPinching) {
                const dx = touches[1].clientX - touches[0].clientX;
                const dy = touches[1].clientY - touches[0].clientY;
                const dist = Math.sqrt(dx*dx + dy*dy);
                const scale = dist / this._pinchStartDist;
                this._zoom = Math.max(this._minZoom, Math.min(this._maxZoom, this._pinchStartZoom / scale));
                this._dirty = true;
                return;
            }

            if (touches.length === 1 && this._dragging && !this._isPinching) {
                const pos = this._getCanvasPos(touches[0]);
                const ddx = pos.x - this._dragStart.x;
                const ddy = pos.y - this._dragStart.y;

                if (!this._hasMoved) {
                    if (Math.sqrt(ddx*ddx + ddy*ddy) > clickThresholdPx()) {
                        this._hasMoved = true;
                        this._clearLongPressTimer();
                    }
                }

                if (this._hasMoved) {
                    const dpr = window.devicePixelRatio || 1;
                    const sensitivity = 0.3 / dpr;
                    this._rotY = this._dragRotYStart + ddx * sensitivity;
                    this._rotX = Math.max(-89, Math.min(89, this._dragRotXStart - ddy * sensitivity));
                    this._dirty = true;
                }
            }
        }, { passive: false });

        c.addEventListener('touchend', (e) => {
            if (this._inert) return;
            this._clearLongPressTimer();
            if (e.touches.length === 0) {
                if (!this._isRightClick && !this._hasMoved && !this._longPressTriggered && !this._isPinching && this._dragStart) {
                    const hit = this._hitTest(this._dragStart.x, this._dragStart.y);
                    if (hit && this.onCellClick) this.onCellClick(hit.face, hit.row, hit.col, ClickType.LeftClick);
                }
                this._dragging = false;
                this._isPinching = false;
            } else if (e.touches.length === 1 && this._isPinching) {
                this._isPinching = false;
                const pos = this._getCanvasPos(e.touches[0]);
                this._dragStart = pos;
                this._dragRotXStart = this._rotX;
                this._dragRotYStart = this._rotY;
                this._hasMoved = true;
            }
        });

        c.addEventListener('touchcancel', (e) => {
            e.preventDefault();
            this._resetPointerInteractionState();
        }, { passive: false });
    }

    destroy() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._resetInteractionState({ resetKeyboard: true });
        if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
        if (this._onKeyUp) document.removeEventListener('keyup', this._onKeyUp);
        if (this._onGlobalKeyUp) window.removeEventListener('keyup', this._onGlobalKeyUp, true);
        if (this._onDocumentMouseUp) document.removeEventListener('mouseup', this._onDocumentMouseUp, true);
        if (this._onWindowMouseUp) window.removeEventListener('mouseup', this._onWindowMouseUp);
        if (this._onWindowBlur) window.removeEventListener('blur', this._onWindowBlur);
        if (this._onVisibilityChange) document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
}
