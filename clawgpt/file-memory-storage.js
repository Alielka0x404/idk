// ClawGPT Memory - File-based persistent storage for cross-device sync
// This writes messages to files that can be accessed by external tools (like OpenClaw agents)
// Default folder: clawgpt-memory/ in the app directory
class FileMemoryStorage {
  constructor() {
    this.dirHandle = null;
    this.dbName = 'clawgpt-file-handles';
    this.db = null;
    this.enabled = false;
    this.pendingWrites = [];
    this.writeDebounce = null;
    this.defaultFolderName = 'clawgpt-memory';
  }

  async init() {
    // Check if File System Access API is available
    if (!('showDirectoryPicker' in window)) {
      console.log('FileMemoryStorage: File System Access API not available');
      return false;
    }

    // Try to restore saved directory handle
    await this.initDB();
    const restored = await this.restoreHandle();
    if (restored) {
      this.enabled = true;
      console.log('FileMemoryStorage: Restored saved directory handle');
    }
    return this.enabled;
  }
  
  // Auto-setup: prompt user to select the clawgpt-memory folder on first run
  async autoSetup() {
    if (this.enabled) return true; // Already set up
    
    // Check if File System Access API is available
    if (!('showDirectoryPicker' in window)) {
      console.log('FileMemoryStorage: Auto-setup skipped (API not available)');
      return false;
    }
    
    return await this.selectDirectory(true);
  }

  async initDB() {
    return new Promise((resolve) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onerror = () => resolve(null);
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('handles')) {
          db.createObjectStore('handles', { keyPath: 'id' });
        }
      };
    });
  }

  async restoreHandle() {
    if (!this.db) return false;

    return new Promise(async (resolve) => {
      try {
        const tx = this.db.transaction(['handles'], 'readonly');
        const store = tx.objectStore('handles');
        const req = store.get('memoryDir');
        
        req.onsuccess = async () => {
          if (req.result?.handle) {
            // Verify we still have permission
            const permission = await req.result.handle.queryPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
              this.dirHandle = req.result.handle;
              resolve(true);
            } else {
              // Permission not granted yet — can't request without user gesture.
              // Store the handle so we can request permission on next user interaction.
              this._pendingHandle = req.result.handle;
              resolve(false);
            }
          } else {
            resolve(false);
          }
        };
        req.onerror = () => resolve(false);
      } catch (e) {
        console.warn('FileMemoryStorage: Error restoring handle:', e);
        resolve(false);
      }
    });
  }

  // Re-request permission for a previously saved handle (must be called from user gesture)
  async reconnect() {
    if (this.enabled) return true;
    if (!this._pendingHandle) return false;

    try {
      const permission = await this._pendingHandle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        this.dirHandle = this._pendingHandle;
        this._pendingHandle = null;
        this.enabled = true;
        console.log('FileMemoryStorage: Reconnected via user gesture');
        return true;
      }
    } catch (e) {
      console.warn('FileMemoryStorage: Reconnect failed:', e);
    }
    return false;
  }

  async selectDirectory(isAutoSetup = false) {
    try {
      // startIn: 'documents' works on Windows/Mac, broken on Linux Chrome
      const options = {
        mode: 'readwrite',
        startIn: 'documents'
      };
      
      this.dirHandle = await window.showDirectoryPicker(options);

      // Save handle for persistence
      if (this.db) {
        const tx = this.db.transaction(['handles'], 'readwrite');
        tx.objectStore('handles').put({ id: 'memoryDir', handle: this.dirHandle });
      }

      this.enabled = true;
      console.log('FileMemoryStorage: Directory selected:', this.dirHandle.name);
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('FileMemoryStorage: Error selecting directory:', e);
      }
      return false;
    }
  }

  async writeMessage(message) {
    if (!this.enabled || !this.dirHandle) return;

    this.pendingWrites.push(message);
    
    // Debounce writes to batch them
    if (this.writeDebounce) clearTimeout(this.writeDebounce);
    this.writeDebounce = setTimeout(() => this.flushWrites(), 1000);
  }

  async flushWrites() {
    if (!this.enabled || !this.dirHandle || this.pendingWrites.length === 0) return;

    const toWrite = [...this.pendingWrites];
    this.pendingWrites = [];

    try {
      // Group messages by date
      const byDate = {};
      for (const msg of toWrite) {
        const date = new Date(msg.timestamp).toISOString().split('T')[0];
        if (!byDate[date]) byDate[date] = [];
        byDate[date].push(msg);
      }

      // Write to date-based files
      for (const [date, messages] of Object.entries(byDate)) {
        await this.appendToDateFile(date, messages);
      }
    } catch (e) {
      console.error('FileMemoryStorage: Error writing messages:', e);
      // Put messages back in queue
      this.pendingWrites = [...toWrite, ...this.pendingWrites];
    }
  }

  async appendToDateFile(date, messages) {
    const filename = `${date}.jsonl`;
    
    try {
      // Get or create file
      const fileHandle = await this.dirHandle.getFileHandle(filename, { create: true });
      
      // Read existing content
      const file = await fileHandle.getFile();
      const existingContent = await file.text();
      
      // Load existing message IDs to avoid duplicates
      const existingIds = new Set();
      if (existingContent) {
        for (const line of existingContent.split('\n')) {
          if (line.trim()) {
            try {
              const msg = JSON.parse(line);
              if (msg.id) existingIds.add(msg.id);
            } catch {}
          }
        }
      }
      
      // Filter out duplicates and append new messages
      const newMessages = messages.filter(m => !existingIds.has(m.id));
      if (newMessages.length === 0) return;
      
      const newLines = newMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
      
      // Write back
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      await writable.seek((await file.size));
      await writable.write(newLines);
      await writable.close();
      
      console.log(`FileMemoryStorage: Wrote ${newMessages.length} messages to ${filename}`);
    } catch (e) {
      console.error(`FileMemoryStorage: Error writing to ${filename}:`, e);
      throw e;
    }
  }

  async writeChat(chat) {
    if (!this.enabled || !this.dirHandle || !chat.messages) return;

    // Write each message with chat context
    for (let i = 0; i < chat.messages.length; i++) {
      const msg = chat.messages[i];
      await this.writeMessage({
        id: `${chat.id}-${i}`,
        chatId: chat.id,
        chatTitle: chat.title || 'Untitled',
        order: i,
        role: msg.role,
        content: msg.content || '',
        timestamp: msg.timestamp || chat.createdAt || Date.now()
      });
    }
  }

  async syncAllChats(chats) {
    if (!this.enabled || !this.dirHandle) return 0;

    let count = 0;
    for (const chat of Object.values(chats)) {
      if (chat.messages) {
        await this.writeChat(chat);
        count += chat.messages.length;
      }
    }
    
    // Force flush
    await this.flushWrites();
    return count;
  }

  // Load chats from memory folder - reconstructs chat objects from JSONL files
  async loadFromMemory() {
    if (!this.enabled || !this.dirHandle) return {};

    const chats = {};
    
    try {
      // List all .jsonl and .json files in the directory
      for await (const entry of this.dirHandle.values()) {
        if (entry.kind === 'file') {
          try {
            const file = await entry.getFile();
            const content = await file.text();
            
            if (entry.name.endsWith('.jsonl')) {
              // JSONL format: one message per line
              for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                
                try {
                  const msg = JSON.parse(line);
                  if (!msg.chatId) continue;
                  
                  // Create or update chat
                  if (!chats[msg.chatId]) {
                    chats[msg.chatId] = {
                      id: msg.chatId,
                      title: msg.chatTitle || 'Untitled',
                      messages: [],
                      createdAt: msg.timestamp,
                      updatedAt: msg.timestamp
                    };
                  }
                  
                  const chat = chats[msg.chatId];
                  
                  // Update timestamps
                  if (msg.timestamp < chat.createdAt) chat.createdAt = msg.timestamp;
                  if (msg.timestamp > chat.updatedAt) chat.updatedAt = msg.timestamp;
                  
                  // Add message (will sort and dedupe later)
                  chat.messages.push({
                    role: msg.role,
                    content: msg.content,
                    timestamp: msg.timestamp,
                    _order: msg.order // Keep original order for sorting
                  });
                } catch (parseErr) {
                  // Skip invalid lines
                }
              }
            } else if (entry.name.endsWith('.json')) {
              // JSON format: export file with {chats: {...}}
              try {
                const data = JSON.parse(content);
                if (data.chats) {
                  console.log(`FileMemoryStorage: Found export file ${entry.name} with ${Object.keys(data.chats).length} chats`);
                  for (const [chatId, chat] of Object.entries(data.chats)) {
                    if (!chats[chatId]) {
                      chats[chatId] = chat;
                    }
                  }
                }
              } catch (parseErr) {
                console.warn(`FileMemoryStorage: Error parsing ${entry.name}:`, parseErr);
              }
            }
          } catch (fileErr) {
            console.warn(`FileMemoryStorage: Error reading ${entry.name}:`, fileErr);
          }
        }
      }
      
      // Sort messages in each chat and remove duplicates
      for (const chat of Object.values(chats)) {
        // Sort by order if available, otherwise by timestamp
        chat.messages.sort((a, b) => {
          if (a._order !== undefined && b._order !== undefined) {
            return a._order - b._order;
          }
          return (a.timestamp || 0) - (b.timestamp || 0);
        });
        
        // Remove _order helper and dedupe by content+role+timestamp
        const seen = new Set();
        chat.messages = chat.messages.filter(m => {
          delete m._order;
          const key = `${m.role}:${m.timestamp}:${m.content?.substring(0, 100)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      
      console.log(`FileMemoryStorage: Loaded ${Object.keys(chats).length} chats from memory folder`);
      return chats;
    } catch (e) {
      console.error('FileMemoryStorage: Error loading from memory:', e);
      return {};
    }
  }

  isEnabled() {
    return this.enabled;
  }

  getDirectoryName() {
    return this.dirHandle?.name || null;
  }
}
