/**
 * CacheManager.js — IndexedDB cache for OSM and elevation data
 */

import { CACHE_DB_NAME, CACHE_TTL } from '../config.js';

const STORE_NAME = 'chunks';

class CacheManager {
  constructor() {
    /** @type {IDBDatabase | null} */
    this.db = null;
    this._initPromise = this._init();
  }

  async _init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };

      request.onerror = (event) => {
        console.warn('IndexedDB failed, caching disabled:', event.target.error);
        resolve(); // Don't block the app
      };
    });
  }

  async _ensureReady() {
    await this._initPromise;
  }

  /**
   * Get cached data
   * @param {string} key 
   * @returns {Promise<any | null>}
   */
  async get(key) {
    await this._ensureReady();
    if (!this.db) return null;

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => {
          const record = request.result;
          if (!record) {
            resolve(null);
            return;
          }

          // Check TTL
          if (Date.now() - record.timestamp > CACHE_TTL) {
            // Expired — delete and return null
            this.delete(key);
            resolve(null);
            return;
          }

          resolve(record.data);
        };

        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Set cached data
   * @param {string} key 
   * @param {any} data 
   */
  async set(key, data) {
    await this._ensureReady();
    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({
          key,
          data,
          timestamp: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /**
   * Check if key exists and is not expired
   * @param {string} key 
   * @returns {Promise<boolean>}
   */
  async has(key) {
    const data = await this.get(key);
    return data !== null;
  }

  /**
   * Delete a specific key
   * @param {string} key 
   */
  async delete(key) {
    await this._ensureReady();
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(key);
    } catch {
      // ignore
    }
  }

  /**
   * Clear all cached data
   */
  async clear() {
    await this._ensureReady();
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
    } catch {
      // ignore
    }
  }
}

// Singleton
export const cache = new CacheManager();
