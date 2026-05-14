// AudioManager.js - Sound effects for reveal, flag, and explosion actions
// ============================================================================

export class AudioManager {
    constructor() {
        this.revealVolume = 0.1;
        this.flagVolume = 0.1;
        this.enabled = true;

        // Keep one audio element per SFX and restart it on each play call,
        // matching the Qt client behavior (stop + play from start).
        this._revealAudio = null;
        this._flagAudio = null;
        this._explosionAudio = null;
    }

    init() {
        this._revealAudio = this._createAudio('../assets/sounds/reveal.wav', this.revealVolume);
        this._flagAudio = this._createAudio('../assets/sounds/flag.wav', this.flagVolume);
        // Keep explosion volume tied to reveal volume, same as Qt AudioManager.
        this._explosionAudio = this._createAudio('../assets/sounds/explosion.wav', this.revealVolume);
    }

    _createAudio(relativePath, volume) {
        const src = new URL(relativePath, import.meta.url).href;
        const audio = new Audio(src);
        audio.preload = 'auto';
        audio.volume = volume;
        return audio;
    }

    _play(audio) {
        if (!audio || !this.enabled) return;
        try {
            audio.pause();
            audio.currentTime = 0;
            const playPromise = audio.play();
            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch(() => {
                    // Ignore autoplay/user-gesture restrictions silently.
                });
            }
        } catch (e) {
            // Ignore audio playback failures.
        }
    }

    playReveal() {
        this._play(this._revealAudio);
    }

    playFlag() {
        this._play(this._flagAudio);
    }

    playExplosion() {
        this._play(this._explosionAudio);
    }

    setRevealVolume(v) {
        this.revealVolume = v;
        if (this._revealAudio) this._revealAudio.volume = v;
        if (this._explosionAudio) this._explosionAudio.volume = v;
    }

    setFlagVolume(v) {
        this.flagVolume = v;
        if (this._flagAudio) this._flagAudio.volume = v;
    }

    setEnabled(e) { this.enabled = e; }
}
