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
let reportsCache = []; // Store audit reports for fuzzy search
let reportDocsIndex = null; // Map normalized report identifiers to markdown files

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

async function ensureReportsLoaded() {
  if (reportsCache.length > 0) {
    return;
  }

  try {
    const reportsPath = path.join(__dirname, 'data', 'reports.json');
    const data = await fs.readFile(reportsPath, 'utf8');
    const parsed = JSON.parse(data);
    const reportsArray = Array.isArray(parsed) ? parsed : [];
    await ensureReportDocsIndex();

    reportsCache = await Promise.all(
      reportsArray.map(async (item, index) => {
        const base = (item && typeof item === 'object') ? item : {};
        const slugSource = base.slug || base.title || base.github_repo || base.url || `report-${index + 1}`;
        const slugCandidate = createSlug(String(slugSource));
        const slug = slugCandidate || `report-${index + 1}`;
        const reportWithSlug = { ...base, slug };
        const explanationPath = await resolveExplanationPath(reportWithSlug);

        return {
          ...reportWithSlug,
          explanationPath: explanationPath || null,
          hasExplanation: Boolean(explanationPath),
        };
      })
    );

    if (!Array.isArray(parsed)) {
      console.warn('Expected reports.json to contain an array of reports. Ignoring invalid data.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to load reports.json:', error);
    }
    reportsCache = [];
  }
}

function normalizeText(value) {
  if (!value) return '';
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    const currentRow = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      const insertCost = currentRow[j] + 1;
      const deleteCost = previousRow[j + 1] + 1;
      const replaceCost = previousRow[j] + (a[i] === b[j] ? 0 : 1);
      currentRow.push(Math.min(insertCost, deleteCost, replaceCost));
    }
    for (let j = 0; j <= b.length; j += 1) {
      previousRow[j] = currentRow[j];
    }
  }
  return previousRow[b.length];
}

function createSlug(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function ensureReportDocsIndex() {
  if (reportDocsIndex !== null) {
    return;
  }

  try {
    const reportsDir = path.join(__dirname, 'data', 'reports');
    const entries = await fs.readdir(reportsDir);
    reportDocsIndex = {};

    entries.forEach((entry) => {
      if (entry.toLowerCase().endsWith('.md')) {
        const baseName = entry.slice(0, -3);
        const normalized = normalizeText(baseName);
        if (normalized) {
          reportDocsIndex[normalized] = path.join(reportsDir, entry);
        }
      }
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to read reports directory:', error);
    }
    reportDocsIndex = {};
  }
}

function buildReportDocCandidates(report, slug) {
  const candidates = new Set();
  if (slug) candidates.add(slug);
  if (report.title) candidates.add(report.title);

  if (report.github_repo) {
    candidates.add(report.github_repo);
    const segments = report.github_repo.split('/').filter(Boolean);
    if (segments.length > 0) {
      candidates.add(segments[segments.length - 1]);
    }
  }

  if (report.url) {
    candidates.add(report.url);
    try {
      const urlObj = new URL(report.url);
      if (urlObj.pathname) {
        const fileName = path.basename(urlObj.pathname);
        if (fileName) {
          candidates.add(fileName);
          candidates.add(fileName.replace(/\.[^.]+$/, ''));
        }
      }
    } catch (error) {
      // Ignore malformed URLs
    }
  }

  return Array.from(candidates).filter(Boolean);
}

function findDocPathForCandidates(candidates) {
  if (!reportDocsIndex) {
    return null;
  }

  let bestPath = null;
  let bestSimilarity = 0;
  const entries = Object.entries(reportDocsIndex);

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (normalized && reportDocsIndex[normalized]) {
      return reportDocsIndex[normalized];
    }

    if (!normalized) {
      continue;
    }

    entries.forEach(([key, value]) => {
      const maxLength = Math.max(key.length, normalized.length, 1);
      const distance = levenshteinDistance(key, normalized);
      const similarity = 1 - distance / maxLength;
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestPath = value;
      }
    });
  }

  if (bestPath && bestSimilarity >= 0.6) {
    return bestPath;
  }

  return null;
}

async function resolveExplanationPath(report) {
  await ensureReportDocsIndex();
  const slugSource = report.slug || report.title || report.github_repo || report.url;
  const slug = slugSource ? createSlug(String(slugSource)) : '';
  const candidates = buildReportDocCandidates(report, slug);
  return findDocPathForCandidates(candidates);
}

function sanitizeReport(report) {
  if (!report) {
    return null;
  }

  const { explanationPath, ...publicFields } = report;
  return publicFields;
}

function findBestReportMatch(query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return null;
  }

  let bestMatch = null;
  let bestScore = -Infinity;

  reportsCache.forEach((report) => {
    const candidates = [
      report.title,
      report.github_repo,
      report.url,
    ]
      .filter(Boolean)
      .map((value) => normalizeText(value));

    candidates.forEach((candidate) => {
      if (!candidate) return;

      if (candidate.includes(normalizedQuery) || normalizedQuery.includes(candidate)) {
        const score = normalizedQuery.length / Math.max(candidate.length, 1);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = report;
        }
        return;
      }

      const distance = levenshteinDistance(candidate, normalizedQuery);
      const maxLength = Math.max(candidate.length, normalizedQuery.length, 1);
      const similarity = 1 - distance / maxLength;
      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatch = report;
      }
    });
  });

  if (bestScore < 0.45) {
    return null;
  }

  return { report: bestMatch, score: bestScore };
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

app.get('/api/reports/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    await ensureReportsLoaded();
    const result = findBestReportMatch(query);

    if (!result) {
      return res.json({ success: false, message: 'No matching report found' });
    }

    res.json({ success: true, match: sanitizeReport(result.report), score: result.score });
  } catch (error) {
    console.error('Report search failed:', error);
    res.status(500).json({ error: 'Failed to search reports' });
  }
});

app.get('/api/reports/:slug/explain', async (req, res) => {
  try {
    const { slug } = req.params;
    await ensureReportsLoaded();

    const normalizedSlug = normalizeText(slug);
    const report = reportsCache.find((item) => normalizeText(item.slug) === normalizedSlug);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const explanationPath = report.explanationPath || await resolveExplanationPath(report);
    if (!explanationPath) {
      return res.json({ success: false, message: 'Explanation not available for this report.' });
    }

    const markdown = await fs.readFile(explanationPath, 'utf8');
    res.json({
      success: true,
      report: sanitizeReport(report),
      markdown,
    });
  } catch (error) {
    console.error('Failed to load report explanation:', error);
    res.status(500).json({ error: 'Failed to load report explanation' });
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
    await ensureReportsLoaded();
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
