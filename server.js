import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import { ethers } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });

// 0G Configuration
const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai';
const EVM_RPC = 'https://evmrpc-testnet.0g.ai';
const PRIVATE_KEY = process.env.PRIVATE_KEY || 'YOUR_PRIVATE_KEY';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage for demo (replace with actual 0G storage)
let bugsCache = [];
let uploadedFileHash = null; // Store the hash of the last uploaded file

// Initialize 0G client
let indexer;
let signer;
try {
  indexer = new Indexer(INDEXER_RPC);
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  signer = new ethers.Wallet(PRIVATE_KEY, provider);
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

    // Upload to 0G storage
    try {
      const file = await ZgFile.fromFilePath(req.file.path);
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr !== null) {
        throw new Error(`Error generating Merkle tree: ${treeErr}`);
      }

      const [tx, uploadErr] = await indexer.upload(file, EVM_RPC, signer);
      if (uploadErr !== null) {
        throw new Error(`Upload error: ${uploadErr}`);
      }

      // Store the root hash for future reference
      uploadedFileHash = tree.rootHash();
      console.log("File uploaded to 0G storage. Root Hash:", uploadedFileHash);
      console.log("Transaction:", tx);

      await file.close();
    } catch (uploadError) {
      console.error('0G Storage upload error:', uploadError);
      // If 0G upload fails, continue with local storage
    }

    // Store to local cache and file for demo purposes
    bugsCache = jsonData;
    await fs.writeFile('data/bugs.json', JSON.stringify(jsonData, null, 2));

    // Clean up uploaded file
    await fs.unlink(req.file.path);

    res.json({ 
      success: true, 
      message: 'File uploaded successfully',
      count: jsonData.length,
      rootHash: uploadedFileHash
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Download JSON file from 0G storage
app.get('/api/download/:rootHash', async (req, res) => {
  try {
    const { rootHash } = req.params;
    
    if (!rootHash) {
      return res.status(400).json({ error: 'Root hash is required' });
    }

    // Create a temporary file path for download
    const tempFilePath = `downloads/temp-${Date.now()}.json`;
    await fs.mkdir('downloads', { recursive: true }).catch(() => {});

    // Download from 0G storage
    const err = await indexer.download(rootHash, tempFilePath, true);
    if (err !== null) {
      throw new Error(`Download error: ${err}`);
    }

    // Read the downloaded file
    const fileContent = await fs.readFile(tempFilePath, 'utf8');
    const jsonData = JSON.parse(fileContent);

    // Clean up temporary file
    await fs.unlink(tempFilePath).catch(() => {});

    // Update cache
    bugsCache = jsonData;

    res.json({
      success: true,
      data: jsonData,
      message: 'File downloaded successfully from 0G storage'
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all bugs (from cache or local file)
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

// Get last uploaded file hash
app.get('/api/file-hash', (req, res) => {
  res.json({ rootHash: uploadedFileHash });
});

// Get admin credentials for verification (in a real app, this should be more secure)
app.get('/api/admin-credentials', (req, res) => {
  const adminEmail = process.env['EMAIL_0G'] || 'admin@example.com';
  const adminPassword = process.env['DUMMY_0G'] || 'dummy';
  
  res.json({ 
    email: adminEmail,
    password: adminPassword
  });
});

// Initialize data directory
async function initDataDir() {
  try {
    await fs.mkdir('data', { recursive: true });
    await fs.mkdir('uploads', { recursive: true });
    await fs.mkdir('downloads', { recursive: true });
  } catch (error) {
    console.error('Failed to create directories:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3001;

initDataDir().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
  });

  // Handle port in use error
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} is busy, trying ${PORT + 1}`);
      setTimeout(() => {
        server.close();
        app.listen(PORT + 1, () => {
          console.log(`Server running on port ${PORT + 1}`);
          console.log(`Open http://localhost:${PORT + 1} in your browser`);
        });
      }, 1000);
    }
  });
});
