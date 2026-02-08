// IndexedDB wrapper for chat storage
class ChatStorage {
  constructor() {
    this.dbName = 'clawgpt';
    this.dbVersion = 2; // Bumped for images store
    this.storeName = 'chats';
    this.imageStoreName = 'images';
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.warn('IndexedDB not available, falling back to localStorage');
        this.useFallback = true;
        resolve(null);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id' });
        }
        // New: image blob store keyed by "chatId-msgIndex"
        if (!db.objectStoreNames.contains(this.imageStoreName)) {
          const imgStore = db.createObjectStore(this.imageStoreName, { keyPath: 'key' });
          imgStore.createIndex('chatId', 'chatId', { unique: false });
        }
      };
    });
  }

  async loadAll() {
    // Migrate from localStorage if needed
    const legacyData = localStorage.getItem('clawgpt-chats');

    if (this.useFallback) {
      return legacyData ? JSON.parse(legacyData) : {};
    }

    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        const chats = {};
        request.result.forEach(chat => {
          chats[chat.id] = chat;
        });

        // If IndexedDB is empty but localStorage has data, migrate it
        if (Object.keys(chats).length === 0 && legacyData) {
          const legacy = JSON.parse(legacyData);
          this.saveAll(legacy).then(() => {
            // Clear localStorage after successful migration
            localStorage.removeItem('clawgpt-chats');
            console.log('Migrated chats from localStorage to IndexedDB');
          });
          resolve(legacy);
        } else {
          resolve(chats);
        }
      };

      request.onerror = () => {
        console.error('Failed to load chats from IndexedDB');
        resolve(legacyData ? JSON.parse(legacyData) : {});
      };
    });
  }

  async saveAll(chats) {
    if (this.useFallback) {
      localStorage.setItem('clawgpt-chats', JSON.stringify(chats));
      return;
    }

    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      // Clear and re-add all (simple approach)
      store.clear();

      Object.values(chats).forEach(chat => {
        store.put(chat);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        console.error('Failed to save chats to IndexedDB, using localStorage fallback');
        localStorage.setItem('clawgpt-chats', JSON.stringify(chats));
        resolve();
      };
    });
  }

  async saveOne(chat) {
    if (this.useFallback) {
      const all = JSON.parse(localStorage.getItem('clawgpt-chats') || '{}');
      all[chat.id] = chat;
      localStorage.setItem('clawgpt-chats', JSON.stringify(all));
      return;
    }

    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      store.put(chat);
      transaction.oncomplete = () => resolve();
      transaction.onerror = (e) => {
        console.error('Failed to save chat:', e);
        this.checkStorageQuota();
        reject(transaction.error);
      };
    });
  }

  // ===== IMAGE PERSISTENCE =====

  // Save images for a message (key = "chatId-msgIndex")
  async saveImages(chatId, msgIndex, images) {
    if (this.useFallback || !images || images.length === 0) return;

    await this.init();
    if (!this.db.objectStoreNames.contains(this.imageStoreName)) return;

    const key = `${chatId}-${msgIndex}`;
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction([this.imageStoreName], 'readwrite');
        const store = transaction.objectStore(this.imageStoreName);
        store.put({ key, chatId, msgIndex, images, savedAt: Date.now() });
        transaction.oncomplete = () => resolve();
        transaction.onerror = (e) => {
          console.warn('Failed to save images:', e);
          resolve(); // Don't block on image save failure
        };
      } catch (e) {
        console.warn('Image store not available:', e);
        resolve();
      }
    });
  }

  // Load images for a specific message
  async loadImages(chatId, msgIndex) {
    if (this.useFallback) return null;

    await this.init();
    if (!this.db.objectStoreNames.contains(this.imageStoreName)) return null;

    const key = `${chatId}-${msgIndex}`;
    return new Promise((resolve) => {
      try {
        const transaction = this.db.transaction([this.imageStoreName], 'readonly');
        const store = transaction.objectStore(this.imageStoreName);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result?.images || null);
        request.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Load all images for a chat (for restoring session)
  async loadChatImages(chatId) {
    if (this.useFallback) return new Map();

    await this.init();
    if (!this.db.objectStoreNames.contains(this.imageStoreName)) return new Map();

    return new Promise((resolve) => {
      try {
        const transaction = this.db.transaction([this.imageStoreName], 'readonly');
        const store = transaction.objectStore(this.imageStoreName);
        const index = store.index('chatId');
        const request = index.getAll(chatId);
        request.onsuccess = () => {
          const imageMap = new Map();
          (request.result || []).forEach(entry => {
            imageMap.set(entry.key, entry.images);
          });
          resolve(imageMap);
        };
        request.onerror = () => resolve(new Map());
      } catch (e) {
        resolve(new Map());
      }
    });
  }

  // Delete images for a chat (when chat is deleted)
  async deleteChatImages(chatId) {
    if (this.useFallback) return;

    await this.init();
    if (!this.db.objectStoreNames.contains(this.imageStoreName)) return;

    return new Promise((resolve) => {
      try {
        const transaction = this.db.transaction([this.imageStoreName], 'readwrite');
        const store = transaction.objectStore(this.imageStoreName);
        const index = store.index('chatId');
        const request = index.getAllKeys(chatId);
        request.onsuccess = () => {
          (request.result || []).forEach(key => store.delete(key));
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async checkStorageQuota() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const usedMB = Math.round((estimate.usage || 0) / 1024 / 1024);
        const quotaMB = Math.round((estimate.quota || 0) / 1024 / 1024);
        const usedPercent = quotaMB > 0 ? Math.round((usedMB / quotaMB) * 100) : 0;
        if (usedPercent > 90) {
          console.warn(`Storage nearly full: ${usedMB}MB / ${quotaMB}MB (${usedPercent}%)`);
          showErrorBanner(`Storage nearly full (${usedPercent}%). Consider deleting old chats.`, true);
        }
      } catch (e) {
        // Silently ignore quota check failures
      }
    }
  }

  async deleteOne(chatId) {
    if (this.useFallback) {
      const all = JSON.parse(localStorage.getItem('clawgpt-chats') || '{}');
      delete all[chatId];
      localStorage.setItem('clawgpt-chats', JSON.stringify(all));
      return;
    }

    await this.init();

    // Also delete associated images
    this.deleteChatImages(chatId).catch(() => {});

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      store.delete(chatId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
}
