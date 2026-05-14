// GridRenderer.js — WebGL-accelerated minesweeper grid renderer
// ============================================================================
//
// All visible cells are drawn in a SINGLE batched WebGL draw call using a
// sprite-atlas texture.  Pan and zoom only update uniforms — zero per-cell
// Canvas API calls.  Decals are rendered on a thin transparent 2D-canvas
// overlay so we can still use fillText / arc for player indicators.
//
// Public API is identical to the previous Canvas-2D GridRenderer so UIManager
// needs zero changes.
//
// ============================================================================

import { CellContent, CellState, GameState, PlayerAction, ClickType, GameType, GameVariant, INVALID_TEAM_ID } from '../../core/CoreEnums.js';
import { getPlayerColorHex, getTeamColorHex, getConquestTeamBackgroundColorHex } from '../../core/CoreTypes.js';

// ─── Visual constants ───────────────────────────────────────────────────────

const BG_COLOR_RGB = [0.2, 0.2, 0.2];  // #333333
const HIDDEN_CLR   = '#888888';
const REVEAL_CLR   = '#BBBBBB';
const MINE_BG      = '#FF4444';
const NUMBER_TEXT_COLORS = ['#0000FF', '#008000', '#FF0000', '#000080', '#800000', '#008080', '#000000', '#808080'];

const DEFAULT_CELL_SIZE = 30;
const CELL_SPACING      = 1;
const DECAL_TOTAL_MS    = 1500;
const DECAL_VISIBLE_MS  = 500;

// Atlas sprite indices
const S_HIDDEN = 0;
const S_EMPTY  = 1;
const S_N1     = 2;   // 2–9 → numbers 1–8
const S_FLAG   = 10;
const S_MINE   = 11;
const S_WRONG  = 12;
const S_DARK_EMPTY = 13;
const S_N0 = 14;
const S_DIM_N0 = 15;      // dim fog (game over), adj=0
const S_DIM_N1 = 16;      // 16–23 → dim numbers 1–8
const S_EXPLODED = 24;
const S_CONQUEST_FLAG = 25;
const N_SPRITES = 26;

const GRID_SVG_ASSETS = {
    n0: 'src/assets/grid/0.svg',
    n1: 'src/assets/grid/1.svg',
    n2: 'src/assets/grid/2.svg',
    n3: 'src/assets/grid/3.svg',
    n4: 'src/assets/grid/4.svg',
    n5: 'src/assets/grid/5.svg',
    n6: 'src/assets/grid/6.svg',
    n7: 'src/assets/grid/7.svg',
    n8: 'src/assets/grid/8.svg',
    flag: 'src/assets/grid/flag.svg',
    mine: 'src/assets/grid/mine.svg',
    wrong: 'src/assets/grid/wrong_flag.svg',
    exploded: 'src/assets/grid/mine_exploded.svg',
};

// ─── Shader sources ─────────────────────────────────────────────────────────

const VERT_SRC = `
attribute vec2 a_pos;        // quad corner (0,0)→(1,1)
attribute vec2 a_cellXY;     // grid column, row
attribute float a_sprite;    // sprite index into atlas
attribute vec4 a_tint;       // rgb + strength for conquest-owned backgrounds
attribute vec4 a_edgeData;   // rgb + side bitmask for conquest blob outline

uniform vec2 u_viewSize;     // canvas size in logical px
uniform vec2 u_offset;       // pan offset in logical px
uniform float u_cellSize;    // cell size in logical px
uniform float u_stride;      // cellSize + spacing
uniform float u_atlasInv;    // 1.0 / N_SPRITES
uniform float u_uvInsetX;    // normalized inset in atlas X
uniform float u_uvInsetY;    // normalized inset in atlas Y

varying vec2 v_uv;
varying vec4 v_tint;
varying vec2 v_cellUV;
varying vec4 v_edgeData;

void main() {
    // World position of this vertex
    vec2 world = vec2(
        u_offset.x + a_cellXY.x * u_stride + a_pos.x * u_cellSize,
        u_offset.y + a_cellXY.y * u_stride + a_pos.y * u_cellSize
    );

    // Map to clip space  (-1..+1),  Y flipped for screen coords
    vec2 clip = (world / u_viewSize) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);

    // UV into atlas row (sprite index selects horizontal slice)
    float u0 = a_sprite * u_atlasInv + u_uvInsetX;
    float u1 = (a_sprite + 1.0) * u_atlasInv - u_uvInsetX;
    float v0 = u_uvInsetY;
    float v1 = 1.0 - u_uvInsetY;
    v_uv = vec2(mix(u0, u1, a_pos.x), mix(v0, v1, a_pos.y));
    v_tint = a_tint;
    v_cellUV = a_pos;
    v_edgeData = a_edgeData;
}
`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D u_atlas;
varying vec2 v_uv;
varying vec4 v_tint;
varying vec2 v_cellUV;
varying vec4 v_edgeData;
void main() {
    vec4 tex = texture2D(u_atlas, v_uv);
    vec3 revealBg = vec3(187.0 / 255.0);
    vec3 hiddenBg = vec3(136.0 / 255.0);
    vec3 mineBg = vec3(1.0, 68.0 / 255.0, 68.0 / 255.0);
    float bgDistance = min(distance(tex.rgb, revealBg), min(distance(tex.rgb, hiddenBg), distance(tex.rgb, mineBg)));
    float bgMask = 1.0 - smoothstep(0.025, 0.075, bgDistance);
    if (v_tint.a > 0.0) {
        vec3 tintedBg = mix(tex.rgb, v_tint.rgb, v_tint.a);
        tex.rgb = mix(tex.rgb, tintedBg, bgMask);
    }
    if (v_edgeData.a > 0.0) {
        float sideMask = v_edgeData.a;
        float topSide = step(0.5, mod(sideMask, 2.0));
        float rightSide = step(0.5, mod(floor(sideMask / 2.0), 2.0));
        float bottomSide = step(0.5, mod(floor(sideMask / 4.0), 2.0));
        float leftSide = step(0.5, mod(floor(sideMask / 8.0), 2.0));
        float topRightCorner = step(0.5, mod(floor(sideMask / 16.0), 2.0));
        float bottomRightCorner = step(0.5, mod(floor(sideMask / 32.0), 2.0));
        float bottomLeftCorner = step(0.5, mod(floor(sideMask / 64.0), 2.0));
        float topLeftCorner = step(0.5, mod(floor(sideMask / 128.0), 2.0));
        float edgeWidth = 0.065;
        float topEdge = topSide * (1.0 - step(edgeWidth, v_cellUV.y));
        float rightEdge = rightSide * step(1.0 - edgeWidth, v_cellUV.x);
        float bottomEdge = bottomSide * step(1.0 - edgeWidth, v_cellUV.y);
        float leftEdge = leftSide * (1.0 - step(edgeWidth, v_cellUV.x));
        float cornerRight = step(1.0 - edgeWidth, v_cellUV.x);
        float cornerBottom = step(1.0 - edgeWidth, v_cellUV.y);
        float cornerLeft = 1.0 - step(edgeWidth, v_cellUV.x);
        float cornerTop = 1.0 - step(edgeWidth, v_cellUV.y);
        float topRightEdge = topRightCorner * cornerRight * cornerTop;
        float bottomRightEdge = bottomRightCorner * cornerRight * cornerBottom;
        float bottomLeftEdge = bottomLeftCorner * cornerLeft * cornerBottom;
        float topLeftEdge = topLeftCorner * cornerLeft * cornerTop;
        float edgeMask = max(max(max(topEdge, rightEdge), max(bottomEdge, leftEdge)),
                             max(max(topRightEdge, bottomRightEdge), max(bottomLeftEdge, topLeftEdge)));
        tex.rgb = mix(tex.rgb, v_edgeData.rgb, edgeMask * bgMask * 0.88);
    }
    gl_FragColor = tex;
}
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCanvas2D(w, h) {
    try { return new OffscreenCanvas(w, h); } catch (_) { /* fallback */ }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
}

function getDPR() { return window.devicePixelRatio || 1; }

function hexToRgb01(hex) {
    const value = hex && hex.startsWith('#') ? hex.slice(1) : hex;
    if (!value || value.length < 6) return [0, 0, 0];
    return [
        parseInt(value.slice(0, 2), 16) / 255,
        parseInt(value.slice(2, 4), 16) / 255,
        parseInt(value.slice(4, 6), 16) / 255,
    ];
}

function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[GridRenderer] Shader compile error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

function createProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error('[GridRenderer] Program link error:', gl.getProgramInfoLog(p));
        gl.deleteProgram(p);
        return null;
    }
    return p;
}

// ─── GridRenderer (WebGL) ───────────────────────────────────────────────────

export class GridRenderer {

    constructor(canvas) {
        this.canvas = canvas;
        this.gridManager = null;

        // Viewport (logical pixels)
        this.cellSize = DEFAULT_CELL_SIZE;
        this.offsetX  = 0;
        this.offsetY  = 0;
        this.minZoom  = 10;
        this.maxZoom  = 180;

        // Dirty / scheduling
        this._gridDirty = true;
        this._running   = false;
        this._rafId     = 0;

        // Decals
        this._decals = [];

        // State flags
        this._paintFalseFlags = false;
        this._paintAllMines   = false;
        this._spectatorMode   = false;
        this._inert           = false;
        this._showDecals      = true;
        this._digitalNumbersEnabled  = false;
        this._digitalTexturesEnabled = false;

        // Interaction state — mirrors Qt GridRenderer exactly
        this._mouseIsDown = false;       // true while a mouse button is held
        this._dragging   = false;        // m_isDragging
        this._dragSX     = 0;            // m_dragStartPos.x
        this._dragSY     = 0;            // m_dragStartPos.y
        this._dragOX     = 0;            // m_offsetAtDragStart.x
        this._dragOY     = 0;            // m_offsetAtDragStart.y
        this._moved      = false;        // m_hasMoved
        this._lpTimer    = null;         // m_longPressTimer
        this._lpFired    = false;        // m_longPressTriggered
        this._isRightClick = false;      // m_isRightClick

        // Touch / pinch state — mirrors Qt
        this._isPinching      = false;   // m_isPinching
        this._pinchTouchCount = 0;       // m_pinchTouchCount
        this._pinchStartCX    = 0;       // m_pinchStartCenter.x
        this._pinchStartCY    = 0;       // m_pinchStartCenter.y
        this._pinchStartScale = 0;       // m_pinchStartScale  (cellSize at pinch start)
        this._pinchStartDist  = 1;       // m_pinchStartDist
        this._pinchStartOX    = 0;       // m_pinchStartOffset.x
        this._pinchStartOY    = 0;       // m_pinchStartOffset.y

        // Keyboard selection (mirrors Qt GridRenderer::m_hasKeyboardSelection)
        this._hasKbdSel = false;
        this._kbdSelX   = -1;
        this._kbdSelY   = -1;

        // Shift+Arrow smooth pan state (mirrors Qt GridRenderer shift-pan)
        this._shiftPanLeft  = false;
        this._shiftPanRight = false;
        this._shiftPanUp    = false;
        this._shiftPanDown  = false;
        this._kbdPanTimer    = null;
        this._kbdPanLastTime = 0;

        // Public callbacks
        this.onCellClick      = null;
        this.onKbdSelChanged  = null; // (visible: bool, x: int, y: int)

        // Reusable objects
        this._reuseTchPos  = { x: 0, y: 0 };
        this._reuseCellPos = { x: 0, y: 0 };
        this._cachedRect   = null;

        // ── WebGL init ──
        const gl = canvas.getContext('webgl', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
        });
        this._gl = gl;

        if (!gl) {
            console.error('[GridRenderer] WebGL not available');
        }

        // Decal overlay (2D canvas stacked on top of the WebGL canvas)
        this._decalCanvas = null;
        this._decalCtx    = null;
        this._initDecalOverlay();

        // Shader program + locations
        this._prog     = null;
        this._aPos     = -1;
        this._aCellXY  = -1;
        this._aSprite  = -1;
        this._aTint    = -1;
        this._aEdgeData = -1;
        this._uViewSize = null;
        this._uOffset   = null;
        this._uCellSize = null;
        this._uStride   = null;
        this._uAtlasInv = null;
        this._uUvInsetX = null;
        this._uUvInsetY = null;
        this._uAtlas    = null;

        // GPU buffers
        this._quadVBO   = null;
        this._cellVBO   = null;
        this._spriteVBO = null;
        this._tintVBO   = null;
        this._edgeVBO   = null;
        this._cellBuf   = null;   // Float32Array backing
        this._spriteBuf = null;
        this._tintBuf   = null;
        this._edgeBuf   = null;
        this._instanceCount = 0;
        this._bufCapacity   = 0;

        // Atlas texture
        this._atlasTex = null;
        this._atlasCS  = 0;
        this._atlasDPR = 0;
        this._atlasUnitPx = 0;
        this._spriteImages = new Map();

        // Instanced rendering extension
        this._ext = null;

        if (gl) this._initGL();
        this._loadGridSprites();
        this._bindEvents();
    }

    _loadGridSprites() {
        const keys = Object.keys(GRID_SVG_ASSETS);
        for (const key of keys) {
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => {
                this._gridDirty = true;
                this._atlasCS = 0;
                this._scheduleFrame();
            };
            img.src = GRID_SVG_ASSETS[key];
            this._spriteImages.set(key, img);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // WebGL bootstrap
    // ════════════════════════════════════════════════════════════════════════

    _initGL() {
        const gl = this._gl;

        this._ext = gl.getExtension('ANGLE_instanced_arrays');
        if (!this._ext) {
            console.error('[GridRenderer] ANGLE_instanced_arrays unavailable');
            this._gl = null;
            return;
        }

        const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
        if (!vs || !fs) { this._gl = null; return; }
        this._prog = createProgram(gl, vs, fs);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!this._prog) { this._gl = null; return; }

        gl.useProgram(this._prog);

        this._aPos      = gl.getAttribLocation(this._prog, 'a_pos');
        this._aCellXY   = gl.getAttribLocation(this._prog, 'a_cellXY');
        this._aSprite   = gl.getAttribLocation(this._prog, 'a_sprite');
        this._aTint     = gl.getAttribLocation(this._prog, 'a_tint');
        this._aEdgeData = gl.getAttribLocation(this._prog, 'a_edgeData');
        this._uViewSize = gl.getUniformLocation(this._prog, 'u_viewSize');
        this._uOffset   = gl.getUniformLocation(this._prog, 'u_offset');
        this._uCellSize = gl.getUniformLocation(this._prog, 'u_cellSize');
        this._uStride   = gl.getUniformLocation(this._prog, 'u_stride');
        this._uAtlasInv = gl.getUniformLocation(this._prog, 'u_atlasInv');
        this._uUvInsetX = gl.getUniformLocation(this._prog, 'u_uvInsetX');
        this._uUvInsetY = gl.getUniformLocation(this._prog, 'u_uvInsetY');
        this._uAtlas    = gl.getUniformLocation(this._prog, 'u_atlas');

        // Static unit-quad (two triangles: [0,0]→[1,1])
        this._quadVBO = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 0,  1, 0,  1, 1,
            0, 0,  1, 1,  0, 1,
        ]), gl.STATIC_DRAW);

        // Per-instance buffers (sized dynamically)
        this._cellVBO   = gl.createBuffer();
        this._spriteVBO = gl.createBuffer();
        this._tintVBO   = gl.createBuffer();
        this._edgeVBO   = gl.createBuffer();

        // Atlas texture
        this._atlasTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._atlasTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.clearColor(BG_COLOR_RGB[0], BG_COLOR_RGB[1], BG_COLOR_RGB[2], 1.0);
    }

    /** Create transparent 2D overlay canvas for decals, stacked over the WebGL canvas. */
    _initDecalOverlay() {
        const parent = this.canvas.parentElement;
        if (!parent) return;

        const id = 'decal-overlay-' + this.canvas.id;
        let overlay = parent.querySelector('.' + id);
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.className = id;
            overlay.style.cssText =
                'position:absolute;pointer-events:none;';
            parent.appendChild(overlay);
        }
        this._decalCanvas = overlay;
        this._decalCtx = overlay.getContext('2d');
    }

    _syncDecalOverlayGeometry(rect) {
        if (!this._decalCanvas) return;
        this._decalCanvas.style.left = `${this.canvas.offsetLeft || 0}px`;
        this._decalCanvas.style.top = `${this.canvas.offsetTop || 0}px`;
        this._decalCanvas.style.width = rect.width + 'px';
        this._decalCanvas.style.height = rect.height + 'px';
    }

    // ════════════════════════════════════════════════════════════════════════
    // Atlas — rendered to a 2D canvas, uploaded as WebGL texture
    // ════════════════════════════════════════════════════════════════════════

    _ensureAtlas() {
        const d = getDPR();
        if (this._atlasCS === this.cellSize && this._atlasDPR === d) return;
        if (this._isPinching && this._atlasCS !== 0) return;
        this._buildAtlas(d);
    }

    _buildAtlas(deviceRatio) {
        const cs = this.cellSize;
        this._atlasCS  = cs;
        this._atlasDPR = deviceRatio;

        let u = Math.ceil(cs * deviceRatio * ((this._digitalNumbersEnabled || this._digitalTexturesEnabled) ? 2.0 : 1.5));
        if (this._gl) {
            const maxTex = this._gl.getParameter(this._gl.MAX_TEXTURE_SIZE) || 4096;
            const maxU = Math.max(16, Math.floor(maxTex / N_SPRITES));
            u = Math.min(u, maxU);
        }
        u = Math.max(16, u);
        this._atlasUnitPx = u;
        const c2d = makeCanvas2D(N_SPRITES * u, u);
        const g = c2d.getContext('2d');
        g.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';

        const hiddenBg = (ox) => { g.fillStyle = HIDDEN_CLR; g.fillRect(ox, 0, u, u); };
        const revealBg = (ox) => { g.fillStyle = REVEAL_CLR; g.fillRect(ox, 0, u, u); };
        const dimBg    = (ox) => { g.fillStyle = '#464646';   g.fillRect(ox, 0, u, u); };
        const drawSvg = (key, ox) => {
            const img = this._spriteImages.get(key);
            if (!img || !img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) return;
            g.drawImage(img, ox + u * 0.1, u * 0.1, u * 0.8, u * 0.8);
        };
        const drawNativeNumber = (n, ox) => {
            g.fillStyle = NUMBER_TEXT_COLORS[n - 1] || '#000000';
            g.font = `700 ${Math.floor(u * 0.68)}px "Segoe UI", sans-serif`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(String(n), ox + u * 0.5, u * 0.54);
        };

        const drawEmoji = (emoji, ox) => {
            g.font = `${Math.floor(u * 0.68)}px serif`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(emoji, ox + u * 0.5, u * 0.54);
        };

        const darkBg = (ox) => { g.fillStyle = '#282828'; g.fillRect(ox, 0, u, u); };
        hiddenBg(0);                              // 0: Hidden
        revealBg(u);                              // 1: Empty revealed
        darkBg(S_DARK_EMPTY * u);
        // S_N0: revealed cell with 0 adjacent mines (fog of war mode)
        {
            const ox0 = S_N0 * u;
            revealBg(ox0);
            if (this._digitalNumbersEnabled) {
                drawSvg('n0', ox0);
            } else {
                g.fillStyle = '#808080';
                g.font = `700 ${Math.floor(u * 0.68)}px "Segoe UI", sans-serif`;
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText('0', ox0 + u * 0.5, u * 0.54);
            }
        }
        for (let n = 1; n <= 8; n++) {            // 2–9: Numbers
            const ox = (S_N1 + n - 1) * u;
            revealBg(ox);
            if (this._digitalNumbersEnabled) {
                drawSvg(`n${n}`, ox);
            } else {
                drawNativeNumber(n, ox);
            }
        }
        hiddenBg(S_FLAG * u);                     // 10: Flag
        if (this._digitalTexturesEnabled) {
            drawSvg('flag', S_FLAG * u);
        } else {
            drawEmoji('\uD83D\uDEA9', S_FLAG * u);
        }
        revealBg(S_CONQUEST_FLAG * u);            // 25: Conquest flag
        if (this._digitalTexturesEnabled) {
            drawSvg('flag', S_CONQUEST_FLAG * u);
        } else {
            drawEmoji('\uD83D\uDEA9', S_CONQUEST_FLAG * u);
        }
        g.fillStyle = MINE_BG;                    // 11: Mine
        g.fillRect(S_MINE * u, 0, u, u);
        if (this._digitalTexturesEnabled) {
            drawSvg('mine', S_MINE * u);
        } else {
            drawEmoji('\uD83D\uDCA3', S_MINE * u);
        }
        hiddenBg(S_WRONG * u);                    // 12: Wrong flag
        if (this._digitalTexturesEnabled) {
            drawSvg('wrong', S_WRONG * u);
        } else {
            drawEmoji('\u274C', S_WRONG * u);
        }

        g.fillStyle = MINE_BG;                    // 24: Exploded mine
        g.fillRect(S_EXPLODED * u, 0, u, u);
        if (this._digitalTexturesEnabled) {
            drawSvg('exploded', S_EXPLODED * u);
        } else {
            drawEmoji('\uD83D\uDCA5', S_EXPLODED * u);
        }

        // S_DIM_N0: dim fog (game over), 0 adjacent mines
        {
            const ox = S_DIM_N0 * u;
            dimBg(ox);
            if (this._digitalNumbersEnabled) {
                drawSvg('n0', ox);
            } else {
                g.fillStyle = '#808080';
                g.font = `700 ${Math.floor(u * 0.68)}px "Segoe UI", sans-serif`;
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText('0', ox + u * 0.5, u * 0.54);
            }
        }
        for (let n = 1; n <= 8; n++) {             // S_DIM_N1..N8: dim fog numbers
            const ox = (S_DIM_N1 + n - 1) * u;
            dimBg(ox);
            if (this._digitalNumbersEnabled) {
                drawSvg(`n${n}`, ox);
            } else {
                drawNativeNumber(n, ox);
            }
        }

        // Upload to GPU
        if (!this._gl) return;
        const gl = this._gl;
        gl.bindTexture(gl.TEXTURE_2D, this._atlasTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c2d);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Instance buffer management
    // ════════════════════════════════════════════════════════════════════════

    _ensureInstanceCapacity(count) {
        if (count <= this._bufCapacity) return;
        const cap = Math.max(count, Math.ceil(this._bufCapacity * 1.5), 256);
        this._cellBuf   = new Float32Array(cap * 2);
        this._spriteBuf = new Float32Array(cap);
        this._tintBuf   = new Float32Array(cap * 4);
        this._edgeBuf   = new Float32Array(cap * 4);
        this._bufCapacity = cap;
    }

    _conquestOwnerAt(gm, x, y) {
        if (!gm || x < 0 || y < 0 || x >= gm.gridData.w || y >= gm.gridData.h) return INVALID_TEAM_ID;
        const cell = gm.grid[y]?.[x];
        if (!cell) return INVALID_TEAM_ID;

        let owner = INVALID_TEAM_ID;
        if (cell.state === CellState.Revealed && typeof gm.revealOwner === 'function') {
            owner = gm.revealOwner(x, y);
        } else if (cell.state === CellState.Flagged && typeof gm.flagOwner === 'function') {
            owner = gm.flagOwner(x, y);
        }
        return typeof gm.isValidConquestTeam === 'function' && gm.isValidConquestTeam(owner)
            ? owner
            : INVALID_TEAM_ID;
    }

    _conquestCellOwnedByTeam(gm, team, x, y) {
        return this._conquestOwnerAt(gm, x, y) === team;
    }

    _buildInstances() {
        const gm = this.gridManager;
        if (!gm || !gm.initialized) { this._instanceCount = 0; return; }

        const gl = this._gl;
        const d  = getDPR();
        const vw = this.canvas.width  / d;
        const vh = this.canvas.height / d;
        const stride = this.cellSize + CELL_SPACING;
        const ox = this.offsetX;
        const oy = this.offsetY;
        const grid = gm.grid;
        const ff = this._paintFalseFlags;
        const paintAllMines = this._paintAllMines;

        // Viewport culling
        const x0 = Math.max(0, Math.floor(-ox / stride));
        const y0 = Math.max(0, Math.floor(-oy / stride));
        const x1 = Math.min(gm.gridData.w, Math.ceil((vw - ox) / stride) + 1);
        const y1 = Math.min(gm.gridData.h, Math.ceil((vh - oy) / stride) + 1);

        const visW = x1 - x0;
        const visH = y1 - y0;
        if (visW <= 0 || visH <= 0) { this._instanceCount = 0; return; }

        const count = visW * visH;
        this._ensureInstanceCapacity(count);

        const cellBuf   = this._cellBuf;
        const spriteBuf = this._spriteBuf;
        const tintBuf   = this._tintBuf;
        const edgeBuf   = this._edgeBuf;
        let idx = 0;

        for (let y = y0; y < y1; y++) {
            const row = grid[y];
            for (let x = x0; x < x1; x++) {
                const cell = row[x];

                let si;
                if (cell.state === CellState.Revealed) {
                    const inFog = gm.gameVariant === GameVariant.FOW && !gm.fogCache.some(p => p.x === x && p.y === y);
                    if (inFog) {
                        const gameOver = gm.gameState === GameState.Lost || gm.gameState === GameState.Won;
                        if (gameOver && cell.content === CellContent.Mine) {
                            si = S_EXPLODED; // this mine was actually revealed
                        } else if (gameOver) {
                            const adj = cell.adj;
                            si = adj > 0 ? S_DIM_N1 + adj - 1 : S_DIM_N0;
                        } else {
                            si = S_DARK_EMPTY;
                        }
                    } else if (cell.content === CellContent.Mine) {
                        si = S_EXPLODED;
                    } else {
                        const adj = cell.adj;
                        if (adj > 0) {
                            si = S_N1 + adj - 1;
                        } else {
                            si = (gm.gameVariant === GameVariant.FOW) ? S_N0 : S_EMPTY;
                        }
                    }
                } else if (cell.state === CellState.Flagged) {
                    const conquestOwner = gm.pvpConquestEnabled?.() && typeof gm.flagOwner === 'function'
                        ? gm.flagOwner(x, y)
                        : INVALID_TEAM_ID;
                    const conquestFlag = typeof gm.isValidConquestTeam === 'function' && gm.isValidConquestTeam(conquestOwner);
                    si = (ff && cell.content !== CellContent.Mine) ? S_WRONG : (conquestFlag ? S_CONQUEST_FLAG : S_FLAG);
                } else if (paintAllMines && cell.content === CellContent.Mine) {
                    si = S_MINE;
                } else {
                    si = S_HIDDEN;
                }

                let tintR = 0;
                let tintG = 0;
                let tintB = 0;
                let tintA = 0;
                let edgeR = 0;
                let edgeG = 0;
                let edgeB = 0;
                let edgeMask = 0;
                if (gm.pvpConquestEnabled?.()) {
                    const owner = this._conquestOwnerAt(gm, x, y);
                    if (owner !== INVALID_TEAM_ID && typeof gm.isValidConquestTeam === 'function' && gm.isValidConquestTeam(owner)) {
                        [tintR, tintG, tintB] = hexToRgb01(getConquestTeamBackgroundColorHex(owner));
                        tintA = 0.50;
                        const edgeColor = hexToRgb01(getTeamColorHex(owner));
                        edgeR = edgeColor[0] * 0.52;
                        edgeG = edgeColor[1] * 0.52;
                        edgeB = edgeColor[2] * 0.52;
                        const sameTop = this._conquestCellOwnedByTeam(gm, owner, x, y - 1);
                        const sameRight = this._conquestCellOwnedByTeam(gm, owner, x + 1, y);
                        const sameBottom = this._conquestCellOwnedByTeam(gm, owner, x, y + 1);
                        const sameLeft = this._conquestCellOwnedByTeam(gm, owner, x - 1, y);
                        if (!sameTop) edgeMask += 1;
                        if (!sameRight) edgeMask += 2;
                        if (!sameBottom) edgeMask += 4;
                        if (!sameLeft) edgeMask += 8;
                        if (sameTop && sameRight && !this._conquestCellOwnedByTeam(gm, owner, x + 1, y - 1)) edgeMask += 16;
                        if (sameRight && sameBottom && !this._conquestCellOwnedByTeam(gm, owner, x + 1, y + 1)) edgeMask += 32;
                        if (sameBottom && sameLeft && !this._conquestCellOwnedByTeam(gm, owner, x - 1, y + 1)) edgeMask += 64;
                        if (sameLeft && sameTop && !this._conquestCellOwnedByTeam(gm, owner, x - 1, y - 1)) edgeMask += 128;
                    }
                }

                cellBuf[idx * 2]     = x;
                cellBuf[idx * 2 + 1] = y;
                spriteBuf[idx]       = si;
                tintBuf[idx * 4]     = tintR;
                tintBuf[idx * 4 + 1] = tintG;
                tintBuf[idx * 4 + 2] = tintB;
                tintBuf[idx * 4 + 3] = tintA;
                edgeBuf[idx * 4]     = edgeR;
                edgeBuf[idx * 4 + 1] = edgeG;
                edgeBuf[idx * 4 + 2] = edgeB;
                edgeBuf[idx * 4 + 3] = edgeMask;
                idx++;
            }
        }
        this._instanceCount = idx;

        gl.bindBuffer(gl.ARRAY_BUFFER, this._cellVBO);
        gl.bufferData(gl.ARRAY_BUFFER, cellBuf.subarray(0, idx * 2), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._spriteVBO);
        gl.bufferData(gl.ARRAY_BUFFER, spriteBuf.subarray(0, idx), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._tintVBO);
        gl.bufferData(gl.ARRAY_BUFFER, tintBuf.subarray(0, idx * 4), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._edgeVBO);
        gl.bufferData(gl.ARRAY_BUFFER, edgeBuf.subarray(0, idx * 4), gl.DYNAMIC_DRAW);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Public API  (identical surface to previous Canvas-2D GridRenderer)
    // ════════════════════════════════════════════════════════════════════════

    setGridManager(gm) {
        this.gridManager = gm;
        this._paintFalseFlags = false;
        this._paintAllMines = false;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    setDigitalNumbersEnabled(enabled) {
        const normalized = !!enabled;
        if (this._digitalNumbersEnabled === normalized) return;
        this._digitalNumbersEnabled = normalized;
        this._atlasCS = 0;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    setDigitalTexturesEnabled(enabled) {
        const normalized = !!enabled;
        if (this._digitalTexturesEnabled === normalized) return;
        this._digitalTexturesEnabled = normalized;
        this._atlasCS = 0;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    markDirty() {
        this._gridDirty = true;
        this._scheduleFrame();
    }

    requestRedraw() {
        this._gridDirty = true;
        this._scheduleFrame();
    }

    centerGrid() {
        const gm = this.gridManager;
        if (!gm) return;
        const d  = getDPR();
        const vw = this.canvas.width  / d;
        const vh = this.canvas.height / d;

        const PAD = 16;
        const fitCS = Math.floor(Math.min(
            (vw - PAD * 2 + CELL_SPACING) / gm.gridData.w - CELL_SPACING,
            (vh - PAD * 2 + CELL_SPACING) / gm.gridData.h - CELL_SPACING
        ));
        this.cellSize = Math.max(this.minZoom, Math.min(this.maxZoom, fitCS));

        const stride = this.cellSize + CELL_SPACING;
        this.offsetX = (vw - (gm.gridData.w * stride - CELL_SPACING)) / 2;
        this.offsetY = (vh - (gm.gridData.h * stride - CELL_SPACING)) / 2;
        this._clampOffset();
        this._gridDirty = true;
        this._scheduleFrame();
    }

    panToCell(x, y) {
        const gm = this.gridManager;
        if (!gm || !gm.initialized) return;
        if (x < 0 || x >= gm.gridData.w || y < 0 || y >= gm.gridData.h) return;

        const d  = getDPR();
        const vw = this.canvas.width  / d;
        const vh = this.canvas.height / d;
        if (vw <= 0 || vh <= 0) return;

        const stride = this.cellSize + CELL_SPACING;
        this.offsetX = vw / 2 - (x * stride + this.cellSize / 2);
        this.offsetY = vh / 2 - (y * stride + this.cellSize / 2);
        this._clampOffset('oneCell');
        this._gridDirty = true;
        this._scheduleFrame();
    }

    resize() {
        const r = this.canvas.parentElement.getBoundingClientRect();
        const d = getDPR();
        const pw = Math.round(r.width  * d);
        const ph = Math.round(r.height * d);

        this.canvas.width  = pw;
        this.canvas.height = ph;
        this.canvas.style.width  = r.width  + 'px';
        this.canvas.style.height = r.height + 'px';

        if (this._gl) {
            this._gl.viewport(0, 0, pw, ph);
        }

        // Match decal overlay size
        if (this._decalCanvas) {
            this._decalCanvas.width  = pw;
            this._decalCanvas.height = ph;
            this._syncDecalOverlayGeometry(r);
        }

        this._gridDirty = true;
        this._scheduleFrame();
    }

    startRenderLoop() {
        this._running   = true;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    stopRenderLoop() {
        this._running = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }
        this.stopAllKbdShiftPan();
        this.hideKbdSelection();
    }

    addDecal(x, y, action, playerID, playerName, ownPlayerID, gameType = GameType.CoOpHard) {
        if (playerID === ownPlayerID) return;
        if (!this._showDecals) return;
        this._decals.push({
            x, y, playerID,
            gameType,
            name: playerName || '',
            isFlag: (action === PlayerAction.FlagSet || action === PlayerAction.FlagClear),
            t: performance.now(),
        });
        this._scheduleFrame();
    }

    revealFalseFlags() {
        this._paintFalseFlags = true;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    revealAllMines() {
        this._paintAllMines = true;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    clearFalseFlags() {
        this._paintFalseFlags = false;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    clearRevealOverlays() {
        this._paintFalseFlags = false;
        this._paintAllMines = false;
        this._gridDirty = true;
        this._scheduleFrame();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Frame scheduling
    // ════════════════════════════════════════════════════════════════════════

    _scheduleFrame() {
        if (this._rafId || !this._running) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = 0;
            if (!this._running) return;
            this._frame();
        });
    }

    _frame() {
        const hasDecals = this._decals.length > 0;
        if (!this._gridDirty && !hasDecals && !this._hasKbdSel) return;
        if (!this._gl) return;

        this._ensureAtlas();

        const gl  = this._gl;
        const ext = this._ext;
        const d   = getDPR();
        const vw  = this.canvas.width  / d;
        const vh  = this.canvas.height / d;

        if (this._gridDirty) {
            this._buildInstances();
            this._gridDirty = false;
        }

        // ── WebGL draw ──
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (this._instanceCount > 0) {
            gl.useProgram(this._prog);

            // Uniforms
            gl.uniform2f(this._uViewSize, vw, vh);
            gl.uniform2f(this._uOffset, this.offsetX, this.offsetY);
            gl.uniform1f(this._uCellSize, this.cellSize);
            gl.uniform1f(this._uStride, this.cellSize + CELL_SPACING);
            gl.uniform1f(this._uAtlasInv, 1.0 / N_SPRITES);
            const atlasUnit = this._atlasUnitPx || Math.max(16, Math.ceil(this.cellSize * d));
            const atlasWidth = N_SPRITES * atlasUnit;
            gl.uniform1f(this._uUvInsetX, 0.75 / atlasWidth);
            gl.uniform1f(this._uUvInsetY, 0.75 / atlasUnit);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._atlasTex);
            gl.uniform1i(this._uAtlas, 0);

            // Attr 0: quad vertex (per-vertex)
            gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVBO);
            gl.enableVertexAttribArray(this._aPos);
            gl.vertexAttribPointer(this._aPos, 2, gl.FLOAT, false, 0, 0);
            ext.vertexAttribDivisorANGLE(this._aPos, 0);

            // Attr 1: cell XY (per-instance)
            gl.bindBuffer(gl.ARRAY_BUFFER, this._cellVBO);
            gl.enableVertexAttribArray(this._aCellXY);
            gl.vertexAttribPointer(this._aCellXY, 2, gl.FLOAT, false, 0, 0);
            ext.vertexAttribDivisorANGLE(this._aCellXY, 1);

            // Attr 2: sprite index (per-instance)
            gl.bindBuffer(gl.ARRAY_BUFFER, this._spriteVBO);
            gl.enableVertexAttribArray(this._aSprite);
            gl.vertexAttribPointer(this._aSprite, 1, gl.FLOAT, false, 0, 0);
            ext.vertexAttribDivisorANGLE(this._aSprite, 1);

            // Attr 3: conquest background tint (per-instance)
            gl.bindBuffer(gl.ARRAY_BUFFER, this._tintVBO);
            gl.enableVertexAttribArray(this._aTint);
            gl.vertexAttribPointer(this._aTint, 4, gl.FLOAT, false, 0, 0);
            ext.vertexAttribDivisorANGLE(this._aTint, 1);

            // Attr 4: conquest blob edge color + side bitmask (per-instance)
            gl.bindBuffer(gl.ARRAY_BUFFER, this._edgeVBO);
            gl.enableVertexAttribArray(this._aEdgeData);
            gl.vertexAttribPointer(this._aEdgeData, 4, gl.FLOAT, false, 0, 0);
            ext.vertexAttribDivisorANGLE(this._aEdgeData, 1);

            // ONE draw call for ALL visible cells
            ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, this._instanceCount);
        }

        // ── Decals on 2D overlay ──
        if (this._decalCtx) {
            const oc   = this._decalCanvas;
            const octx = this._decalCtx;
            if (hasDecals || this._hasKbdSel) {
                octx.setTransform(d, 0, 0, d, 0, 0);
                octx.clearRect(0, 0, vw, vh);
                if (hasDecals) this._drawDecals(octx);
                if (this._hasKbdSel) this._drawKbdCursor(octx);
            } else {
                octx.setTransform(1, 0, 0, 1, 0, 0);
                octx.clearRect(0, 0, oc.width, oc.height);
            }
        }

        if (this._decals.length > 0) {
            this._scheduleFrame();
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Decals (2D canvas overlay — identical to previous implementation)
    // ════════════════════════════════════════════════════════════════════════

    _drawDecals(ctx) {
        const now = performance.now();
        let writeIdx = 0;
        for (let i = 0; i < this._decals.length; i++) {
            if (now - this._decals[i].t < DECAL_TOTAL_MS) {
                this._decals[writeIdx++] = this._decals[i];
            }
        }
        this._decals.length = writeIdx;

        const cs     = this.cellSize;
        const stride = cs + CELL_SPACING;

        for (const d of this._decals) {
            const elapsed = now - d.t;
            let alpha = 1;
            if (elapsed > DECAL_VISIBLE_MS) {
                alpha = 1 - (elapsed - DECAL_VISIBLE_MS) / (DECAL_TOTAL_MS - DECAL_VISIBLE_MS);
            }

            const radius = cs * 0.175;
            const mg     = cs * 0.04;
            const cx     = this.offsetX + d.x * stride + cs - radius - mg;
            const cy     = this.offsetY + d.y * stride + cs - radius - mg;

            ctx.globalAlpha = alpha * 0.85;
            ctx.fillStyle = getPlayerColorHex(d.playerID, d.gameType);
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#000';
            const fs = Math.max(6, Math.floor(radius * 1.4));
            ctx.font = `bold ${fs}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(d.name ? d.name[0].toUpperCase() : '?', cx, cy);

            const iconSize = Math.max(4, Math.floor(radius * 1.2));
            const iconX = cx + radius * 0.55 - iconSize / 2;
            const iconY = cy + radius * 0.55 - iconSize / 2;
            if (d.isFlag) {
                const flagIcon = this._spriteImages.get('flag');
                if (flagIcon && flagIcon.complete && flagIcon.naturalWidth > 0) {
                    ctx.drawImage(flagIcon, iconX, iconY, iconSize, iconSize);
                }
            } else {
                // Use a lightweight vector marker for reveal action decals.
                ctx.beginPath();
                ctx.fillStyle = '#fff';
                ctx.arc(iconX + iconSize * 0.5, iconY + iconSize * 0.5, iconSize * 0.18, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Keyboard selection (mirrors Qt GridRenderer keyboard cursor)
    // ════════════════════════════════════════════════════════════════════════

    _drawKbdCursor(ctx) {
        const gm = this.gridManager;
        if (!gm || !this._hasKbdSel) return;
        const x = this._kbdSelX, y = this._kbdSelY;
        if (x < 0 || y < 0 || x >= gm.gridData.w || y >= gm.gridData.h) return;
        const cs     = this.cellSize;
        const stride = cs + CELL_SPACING;
        const lx     = this.offsetX + x * stride;
        const ly     = this.offsetY + y * stride;
        const bw     = Math.max(2, 1);
        ctx.strokeStyle = 'rgba(255, 230, 120, 0.90)';
        ctx.lineWidth   = bw;
        ctx.strokeRect(lx + bw * 0.5, ly + bw * 0.5, cs - bw, cs - bw);
    }

    ensureKbdSelection() {
        const gm = this.gridManager;
        if (!gm || gm.gridData.w <= 0 || gm.gridData.h <= 0) return false;
        const maxX = gm.gridData.w - 1;
        const maxY = gm.gridData.h - 1;
        if (this._hasKbdSel && this._kbdSelX >= 0 && this._kbdSelX <= maxX &&
            this._kbdSelY >= 0 && this._kbdSelY <= maxY) return true;
        if (this._kbdSelX < 0 || this._kbdSelX > maxX ||
            this._kbdSelY < 0 || this._kbdSelY > maxY) {
            const d = getDPR();
            const vw = this.canvas.width / d, vh = this.canvas.height / d;
            const stride = this.cellSize + CELL_SPACING;
            this._kbdSelX = Math.max(0, Math.min(maxX, Math.floor((vw / 2 - this.offsetX) / stride)));
            this._kbdSelY = Math.max(0, Math.min(maxY, Math.floor((vh / 2 - this.offsetY) / stride)));
        }
        this._hasKbdSel = true;
        this._gridDirty = true;
        this._scheduleFrame();
        if (this.onKbdSelChanged) this.onKbdSelChanged(true, this._kbdSelX, this._kbdSelY);
        return true;
    }

    moveKbdSelection(dx, dy) {
        if (!this.ensureKbdSelection()) return;
        const gm = this.gridManager;
        const nx = this._kbdSelX + dx;
        const ny = this._kbdSelY + dy;
        if (nx < 0 || nx >= gm.gridData.w || ny < 0 || ny >= gm.gridData.h) return;
        this._kbdSelX = nx;
        this._kbdSelY = ny;
        this._keepKbdSelVisible();
        this._gridDirty = true;
        this._scheduleFrame();
        if (this.onKbdSelChanged) this.onKbdSelChanged(true, this._kbdSelX, this._kbdSelY);
    }

    hideKbdSelection() {
        if (!this._hasKbdSel) return;
        this._hasKbdSel = false;
        this._gridDirty = true;
        this._scheduleFrame();
        if (this.onKbdSelChanged) this.onKbdSelChanged(false, -1, -1);
    }

    _keepKbdSelVisible() {
        if (!this._hasKbdSel) return;
        const d = getDPR();
        const vw = this.canvas.width / d, vh = this.canvas.height / d;
        const stride = this.cellSize + CELL_SPACING;
        const cx = this.offsetX + this._kbdSelX * stride;
        const cy = this.offsetY + this._kbdSelY * stride;
        const cs = this.cellSize;
        const margin = stride;
        if (cx < margin)            this.offsetX += margin - cx;
        else if (cx + cs > vw - margin) this.offsetX -= (cx + cs) - (vw - margin);
        if (cy < margin)            this.offsetY += margin - cy;
        else if (cy + cs > vh - margin) this.offsetY -= (cy + cs) - (vh - margin);
        this._clampOffset();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Viewport helpers
    // ════════════════════════════════════════════════════════════════════════

    _clampOffset(mode = 'center') {
        const gm = this.gridManager;
        if (!gm) return;
        const d  = getDPR();
        const vw = this.canvas.width  / d;
        const vh = this.canvas.height / d;
        const stride = this.cellSize + CELL_SPACING;
        const gw = gm.gridData.w * stride - CELL_SPACING;
        const gh = gm.gridData.h * stride - CELL_SPACING;
        const clampAxis = (offset, viewportSpan, gridSpan, margin) => {
            if (viewportSpan <= 0 || gridSpan <= 0) return offset;
            const minOffset = viewportSpan - margin - gridSpan;
            const maxOffset = margin;
            if (minOffset <= maxOffset) {
                return Math.max(minOffset, Math.min(maxOffset, offset));
            }
            return (viewportSpan - gridSpan) / 2;
        };

        const marginX = mode === 'oneCell' ? this.cellSize : vw * 0.5;
        const marginY = mode === 'oneCell' ? this.cellSize : vh * 0.5;
        this.offsetX = clampAxis(this.offsetX, vw, gw, marginX);
        this.offsetY = clampAxis(this.offsetY, vh, gh, marginY);
    }

    _screenToCell(sx, sy) {
        const stride = this.cellSize + CELL_SPACING;
        const x = Math.floor((sx - this.offsetX) / stride);
        const y = Math.floor((sy - this.offsetY) / stride);
        const gm = this.gridManager;
        if (!gm || x < 0 || x >= gm.gridData.w || y < 0 || y >= gm.gridData.h) {
            this._reuseCellPos.x = -1;
            this._reuseCellPos.y = -1;
        } else {
            this._reuseCellPos.x = x;
            this._reuseCellPos.y = y;
        }
        return this._reuseCellPos;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Input events — ported from Qt GridRenderer::touchEvent / mouse*Event
    // ════════════════════════════════════════════════════════════════════════

    static get CLICK_THRESHOLD() { return 10; }
    static get LONG_PRESS_MS()   { return 300; }

    _bindEvents() {
        const c = this.canvas;

        // Mouse events (desktop)
        c.addEventListener('mousedown',   e => this._mouseDown(e));
        c.addEventListener('mousemove',   e => this._mouseMove(e));
        c.addEventListener('mouseup',     e => this._mouseUp(e));
        c.addEventListener('contextmenu', e => e.preventDefault());
        c.addEventListener('wheel', e => {
            e.preventDefault();
            if (this._spectatorMode || this._inert) return;
            // Zoom toward cursor position (matches Qt Ctrl+wheel behavior)
            const factor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
            this._zoomAt(factor, e.offsetX, e.offsetY);
        }, { passive: false });

        // Touch events (mobile)
        c.addEventListener('touchstart',  e => this._touchEvent(e), { passive: false });
        c.addEventListener('touchmove',   e => this._touchEvent(e), { passive: false });
        c.addEventListener('touchend',    e => this._touchEvent(e), { passive: false });
        c.addEventListener('touchcancel', e => this._touchEvent(e), { passive: false });
    }

    // ── Mouse handlers (desktop, mirrors Qt mousePressEvent etc.) ──

    _mouseDown(e) {
        if (this._spectatorMode || this._inert) return;
        this.hideKbdSelection();
        this._mouseIsDown = true;

        const sx = e.offsetX, sy = e.offsetY;
        this._dragSX = sx;
        this._dragSY = sy;
        this._dragOX = this.offsetX;
        this._dragOY = this.offsetY;
        this._moved  = false;
        this._lpFired = false;
        this._isRightClick = (e.button === 2);

        if (this._isRightClick) {
            // Right-click → immediate flag
            const { x, y } = this._screenToCell(sx, sy);
            if (x >= 0 && y >= 0 && this.onCellClick) this.onCellClick(x, y, ClickType.RightClick);
        } else if (!this._isPinching) {
            this._startLongPress(sx, sy);
        }
    }

    _mouseMove(e) {
        if (!this._mouseIsDown) return;
        if (this._spectatorMode || this._inert) return;
        if (this._isRightClick || this._isPinching) return;

        const sx = e.offsetX, sy = e.offsetY;
        const dx = sx - this._dragSX;
        const dy = sy - this._dragSY;

        // Pan immediately on every move (matches Qt handleMouseMove)
        this._dragging = true;
        this.offsetX = this._dragOX + dx;
        this.offsetY = this._dragOY + dy;
        this._clampOffset();
        this._gridDirty = true;
        this._scheduleFrame();

        if (!this._moved) {
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > GridRenderer.CLICK_THRESHOLD) {
                this._moved = true;
                this._cancelLongPress();
            }
        }
    }

    _mouseUp(e) {
        this._mouseIsDown = false;
        if (this._spectatorMode || this._inert) return;

        this._dragging = false;
        this._cancelLongPress();

        if (!this._isRightClick && !this._moved && !this._lpFired && !this._isPinching) {
            const { x, y } = this._screenToCell(e.offsetX, e.offsetY);
            if (x >= 0 && y >= 0 && this.onCellClick) this.onCellClick(x, y, ClickType.LeftClick);
        }
    }

    // ── Unified touch handler (mirrors Qt GridRenderer::touchEvent exactly) ──

    _touchEvent(e) {
        e.preventDefault();
        if (this._spectatorMode || this._inert) return;

        const touches = e.touches;
        const fingerCount = touches.length;
        const type = e.type; // touchstart, touchmove, touchend, touchcancel

        // Cache bounding rect on first contact for the gesture
        if (type === 'touchstart') {
            this._cachedRect = this.canvas.getBoundingClientRect();
        }

        // ── Two-finger pinch-zoom ──
        if (fingerCount === 2) {
            const p1 = this._tchPos(touches[0]);
            const p1x = p1.x, p1y = p1.y;
            const p2 = this._tchPos(touches[1]);
            const p2x = p2.x, p2y = p2.y;

            // (Re)capture pinch origin on first 2-finger contact
            // or after a finger was released and re-pressed
            if (this._pinchTouchCount !== 2) {
                this._isPinching = true;
                this._pinchTouchCount = 2;
                this._cancelLongPress();
                this._pinchStartScale = this.cellSize;
                this._pinchStartOX    = this.offsetX;
                this._pinchStartOY    = this.offsetY;
                this._pinchStartCX    = (p1x + p2x) / 2;
                this._pinchStartCY    = (p1y + p2y) / 2;
                this._pinchStartDist  = Math.max(1, Math.sqrt(
                    (p2x - p1x) * (p2x - p1x) + (p2y - p1y) * (p2y - p1y)
                ));
            }

            const currentCX = (p1x + p2x) / 2;
            const currentCY = (p1y + p2y) / 2;
            const currentDist = Math.sqrt(
                (p2x - p1x) * (p2x - p1x) + (p2y - p1y) * (p2y - p1y)
            );
            const scaleFactor = currentDist / this._pinchStartDist;
            const newSize = Math.max(this.minZoom, Math.min(this.maxZoom,
                Math.round(this._pinchStartScale * scaleFactor)));

            // Compute new offset so the grid point under pinch center stays fixed
            // gridPoint = (pinchStartCenter - pinchStartOffset) / startStride
            const stride0 = this._pinchStartScale + CELL_SPACING;
            const gx = (this._pinchStartCX - this._pinchStartOX) / stride0;
            const gy = (this._pinchStartCY - this._pinchStartOY) / stride0;

            const strideN = newSize + CELL_SPACING;

            this.cellSize = newSize;
            this.offsetX = currentCX - gx * strideN;
            this.offsetY = currentCY - gy * strideN;
            this._clampOffset();
            this._gridDirty = true;
            this._scheduleFrame();
            return;
        }

        // ── Transition: pinch ended, one finger remains ──
        // In the browser, touchend with touches.length===1 means one finger
        // was LIFTED and one REMAINS (touches only lists active fingers).
        // So fingerCount===1 while _isPinching always means "transition to pan".
        if (fingerCount === 1 && this._isPinching) {
            this._isPinching = false;
            this._pinchTouchCount = 1;
            this._dragging = true;
            this._moved = true;           // prevent tap on release
            this._lpFired = false;
            this._isRightClick = false;
            const pt = this._tchPos(touches[0]);
            this._dragSX = pt.x;
            this._dragSY = pt.y;
            this._dragOX = this.offsetX;
            this._dragOY = this.offsetY;
            // Rebuild atlas at final zoom level (pinch is over)
            this._buildAtlas(getDPR());
            this._gridDirty = true;
            this._scheduleFrame();
            return;
        }

        // ── Single-finger tap / pan ──
        if (fingerCount === 1) {
            const pt = this._tchPos(touches[0]);
            const px = pt.x, py = pt.y;

            if (type === 'touchstart') {
                this.hideKbdSelection();
                this._dragSX = px;
                this._dragSY = py;
                this._dragOX = this.offsetX;
                this._dragOY = this.offsetY;
                this._moved  = false;
                this._dragging = false;
                this._lpFired = false;
                this._isRightClick = false;
                this._pinchTouchCount = 1;
                this._startLongPress(px, py);

            } else if (type === 'touchmove') {
                const dx = px - this._dragSX;
                const dy = py - this._dragSY;

                // Pan immediately on every move (matches Qt TouchUpdate)
                this._dragging = true;
                this.offsetX = this._dragOX + dx;
                this.offsetY = this._dragOY + dy;
                this._clampOffset();
                this._gridDirty = true;
                this._scheduleFrame();

                if (!this._moved) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist > GridRenderer.CLICK_THRESHOLD) {
                        this._moved = true;
                        this._cancelLongPress();
                    }
                }

            } else if (type === 'touchend' || type === 'touchcancel') {
                this._dragging = false;
                this._cancelLongPress();
                this._pinchTouchCount = 0;

                if (!this._isRightClick && !this._moved && !this._lpFired) {
                    const { x, y } = this._screenToCell(px, py);
                    if (x >= 0 && y >= 0 && this.onCellClick) this.onCellClick(x, y, ClickType.LeftClick);
                }
            }
            return;
        }

        // ── All fingers lifted (fingerCount === 0) ──
        if (fingerCount === 0) {
            const wasPinching = this._isPinching;
            if (this._isPinching) {
                this._isPinching = false;
                this._pinchTouchCount = 0;
                this._moved = true;           // prevent accidental click after pinch
                this._buildAtlas(getDPR());
                this._gridDirty = true;
                this._scheduleFrame();
            }
            this._dragging = false;
            this._cancelLongPress();
            this._pinchTouchCount = 0;

            // Only fire a click if this was a clean single-finger tap
            // (no drag, no pinch, no long-press)
            if (!wasPinching && !this._isRightClick && !this._moved && !this._lpFired) {
                const { x, y } = this._screenToCell(this._dragSX, this._dragSY);
                if (x >= 0 && y >= 0 && this.onCellClick) this.onCellClick(x, y, true);
            }
            this._cachedRect = null;
        }
    }

    // ── Long-press helpers ──

    _startLongPress(sx, sy) {
        this._cancelLongPress();
        this._lpTimer = setTimeout(() => {
            if (!this._spectatorMode && !this._inert && !this._moved
                && !this._lpFired && !this._isRightClick && !this._isPinching) {
                this._lpFired = true;
                const { x, y } = this._screenToCell(sx, sy);
                if (x >= 0 && y >= 0 && this.onCellClick) this.onCellClick(x, y, ClickType.LongLeftClick);
            }
            this._lpTimer = null;
        }, GridRenderer.LONG_PRESS_MS);
    }

    _cancelLongPress() {
        if (this._lpTimer) {
            clearTimeout(this._lpTimer);
            this._lpTimer = null;
        }
    }

    // ── Touch position helpers ──

    _tchPos(touch) {
        const r = this._cachedRect || this.canvas.getBoundingClientRect();
        this._reuseTchPos.x = touch.clientX - r.left;
        this._reuseTchPos.y = touch.clientY - r.top;
        return this._reuseTchPos;
    }

    // ── Zoom-at-point (mirrors Qt GridRenderer::zoomAt) ──

    _zoomAt(factor, px, py) {
        const prev = this.cellSize;
        const newSize = Math.max(this.minZoom, Math.min(this.maxZoom, Math.round(prev * factor)));
        if (newSize === prev) return;

        const k = newSize / prev;
        this.cellSize = newSize;
        this.offsetX = px - (px - this.offsetX) * k;
        this.offsetY = py - (py - this.offsetY) * k;
        this._clampOffset();
        this._gridDirty = true;
        this._scheduleFrame();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Keyboard zoom  (mirrors Qt GridRenderer::keyboardZoomIn/Out)
    // ════════════════════════════════════════════════════════════════════════

    keyboardZoomIn() {
        const d = getDPR();
        this._zoomAt(1.1, this.canvas.width / d / 2, this.canvas.height / d / 2);
    }

    keyboardZoomOut() {
        const d = getDPR();
        this._zoomAt(1 / 1.1, this.canvas.width / d / 2, this.canvas.height / d / 2);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Shift+Arrow smooth pan  (mirrors Qt GridRenderer shift-pan)
    // ════════════════════════════════════════════════════════════════════════

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
        if (!this.gridManager || !this._anyShiftPanKey()) { this._stopKbdPanTimer(); return; }
        const now = performance.now();
        const dt  = Math.min((now - this._kbdPanLastTime) / 1000, 0.05);
        this._kbdPanLastTime = now;
        const stride = this.cellSize + CELL_SPACING;
        const speed  = Math.max(420, 14 * stride);  // px/s, mirrors Qt keyboardPanSpeedPxPerSec (min=420, mult=14)
        const dx = ((this._shiftPanRight ? 1 : 0) - (this._shiftPanLeft  ? 1 : 0)) * speed * dt;
        const dy = ((this._shiftPanDown  ? 1 : 0) - (this._shiftPanUp    ? 1 : 0)) * speed * dt;
        // Pan direction: arrow = viewport motion direction (content moves opposite)
        this.offsetX -= dx;
        this.offsetY -= dy;
        this._clampOffset();
        this._gridDirty = true;
        this._scheduleFrame();
    }
}

