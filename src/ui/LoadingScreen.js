/**
 * LoadingScreen.js — Loading screen with progress bar
 */

export class LoadingScreen {
  constructor() {
    this.el = document.getElementById('loading-screen');
    this.textEl = document.getElementById('loading-text');
    this.progressBar = document.getElementById('progress-bar');
  }

  show() {
    this.el.classList.add('active');
    this.setProgress(0);
  }

  hide() {
    // Fade out
    this.el.style.transition = 'opacity 0.5s ease';
    this.el.style.opacity = '0';
    setTimeout(() => {
      this.el.classList.remove('active');
      this.el.style.opacity = '1';
      this.el.style.transition = '';
    }, 500);
  }

  /**
   * @param {string} text
   */
  setText(text) {
    this.textEl.textContent = text;
  }

  /**
   * @param {number} percent - 0 to 100
   */
  setProgress(percent) {
    this.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
}
