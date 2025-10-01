import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });

// 0G Configuration
const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai';
const EVM_RPC = 'https://evmrpc-testnet.0g.ai';
const PRIVATE_KEY = process.env.PRIVATE_KEY || 'your_private_key_here';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage for demo (replace with actual 0G storage)
let bugsCache = [];

// Initialize 0G client
let indexer;
try {
  indexer = new Indexer(INDEXER_RPC);
} catch (error) {
  console.error('Failed to initialize 0G Indexer:', error);
}

// Upload JSON file to 0G storage
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Read the uploaded file
    const fileContent = await fs.readFile(req.file.path, 'utf8');
    const jsonData = JSON.parse(fileContent);

    // Validate JSON structure
    if (!Array.isArray(jsonData)) {
      return res.status(400).json({ error: 'JSON must be an array' });
    }

    // Store to 0G (simplified - you'll need to implement actual 0G upload)
    // For now, we'll store in memory and save to local file
    bugsCache = jsonData;
    await fs.writeFile('data/bugs.json', JSON.stringify(jsonData, null, 2));

    // Clean up uploaded file
    await fs.unlink(req.file.path);

    res.json({ 
      success: true, 
      message: 'File uploaded successfully',
      count: jsonData.length 
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all bugs from 0G storage
app.get('/api/bugs', async (req, res) => {
  try {
    // Try to load from file if cache is empty
    if (bugsCache.length === 0) {
      try {
        const data = await fs.readFile('data/bugs.json', 'utf8');
        bugsCache = JSON.parse(data);
      } catch (error) {
        // File doesn't exist yet, return empty array
        bugsCache = [];
      }
    }

    res.json(bugsCache);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Initialize data directory
async function initDataDir() {
  try {
    await fs.mkdir('data', { recursive: true });
    await fs.mkdir('uploads', { recursive: true });
  } catch (error) {
    console.error('Failed to create directories:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3000;

initDataDir().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
  });
});
