const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const zlib = require('zlib');
const { parseZipRecursive, groupByFileType } = require('./unzipUtil');
require('./cron-cleanup');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.use(cors());

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json({ limit: '100mb' }));

// If you parse URL-encoded forms, increase the limit:
app.use(express.urlencoded({ limit: '100mb', extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 1. Configure where and how files are saved
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir); // Save to 'uploads' folder
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

// 2. Strict file filter for ZIP files only
const zipFileFilter = (req, file, cb) => {
    const fileExtension = path.extname(file.originalname).toLowerCase();

    // Accepted ZIP mime types (handles different operating system variations)
    const allowedMimeTypes = [
        'application/zip',
        'application/x-zip-compressed',
        'application/x-compressed',
        'multipart/x-zip'
    ];

    if (fileExtension === '.zip' && allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true); // Accept the file
    } else {
        // Reject the file with an explicit error
        cb(new Error('Only .zip files are allowed!'), false);
    }
};

// 3. Initialize Multer instance
const upload = multer({
    storage: storage,
    fileFilter: zipFileFilter,
    limits: {
        fileSize: 500 * 1024 * 1024 // Optional: Limit file size (e.g., 500MB)
    }
});

// 4. The Upload Endpoint
// 'file' matches the key name in your Vue FormData: formData.append('file', ...)
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Please select a file to upload.' });
        }

        // Path where multer just saved the original zip file
        const uploadedFilePath = req.file.path;

        // 1. Generate the flat list recursively
        const flatFileList = parseZipRecursive(uploadedFilePath);

        // 2. Format / group the data by file type
        const groupedData = groupByFileType(flatFileList);

        // 3. Force the 'log' group to the top of the object
        const sortedGroupedData = {};

        // If 'log' files exist, add them first
        if (groupedData['log']) {
            sortedGroupedData['log'] = groupedData['log'];
        }

        // Add all other file types back in underneath
        Object.keys(groupedData).forEach(key => {
            if (key !== 'log') {
                sortedGroupedData[key] = groupedData[key];
            }
        });

        // Return the detailed breakdown back to your Vue frontend
        res.status(200).json({
            zipFileName: req.file.filename,
            message: 'SDU file processed successfully!',
            totalFilesFound: flatFileList.length,
            filesByType: sortedGroupedData // <-- Returns the sorted object
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Server error occurred during upload.' });
    }
});

app.post('/api/get-file-content', async (req, res) => {
    const { fileName, zipFileName } = req.body;
    let { nestedDirectory } = req.body; // Optional: For files inside subfolders in the ZIP

    // Sanitize root directories to prevent malformed string concatenation pathways
    nestedDirectory = nestedDirectory === 'root' ? '' : nestedDirectory;
    console.log("Incoming Request Body:", req.body);

    // Validate that we have the bare minimum required to track down the file
    if (!fileName || !zipFileName) {
        return res.status(400).json({ error: 'Missing fileName or zipFileName' });
    }

    // 1. Point dynamically and safely to ONLY the physical .zip archive file on your disk
    const baseUploadsDir = path.resolve(__dirname, 'uploads');
    const absoluteZipPath = path.resolve(baseUploadsDir, zipFileName);

    console.log("Target ZIP Archive Path on Disk:", absoluteZipPath);

    // Security & Existence check: Make sure the file exists and hasn't broken out of the uploads directory
    if (!absoluteZipPath.startsWith(baseUploadsDir) || !fs.existsSync(absoluteZipPath)) {
        return res.status(404).json({ error: 'ZIP file archive not found on server storage.' });
    }

    try {
        // 2. Open the ZIP container's central index headers in memory
        const directory = await unzipper.Open.file(absoluteZipPath);

        // 3. Reconstruct what the full file path looks like inside the ZIP archive using uniform forward slashes (/)
        const internalTargetPath = nestedDirectory
            ? `${nestedDirectory}/${fileName}`.replace(/\\/g, '/')
            : fileName.replace(/\\/g, '/');

        console.log("Searching ZIP internally for target path:", internalTargetPath);

        // 4. Find the matching file item entry within the unzipper index map
        const targetFile = directory.files.find(file => {
            const cleanEntryPath = file.path.replace(/\\/g, '/');
            return cleanEntryPath === internalTargetPath;
        });

        if (!targetFile) {
            return res.status(404).json({ error: `File "${internalTargetPath}" not found inside the ZIP archive.` });
        }

        // 5. Stream the single compressed data entry into a buffer memory segment
        const compressedBuffer = await targetFile.buffer();
        let textContent = '';

        // 6. Double Decompression check: Handle nested .gz files dynamically in memory
        if (fileName.toLowerCase().endsWith('.gz')) {
            console.log(`Processing deep Gzip decompression layer for: ${fileName}`);
            const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
            textContent = decompressedBuffer.toString('utf-8');
        } else {
            // Standard plaintext assets (.log, .txt, .xml, .ini)
            textContent = compressedBuffer.toString('utf-8');
        }

        // 7. Return raw text payload back directly to Monaco Editor
        return res.json({ content: textContent });

    } catch (error) {
        console.error('Error reading file from ZIP:', error);
        return res.status(500).json({ error: 'Failed to process ZIP stream archive.' });
    }
});

const getFileExtension = (filename) => {
    let cleanName = filename.toLowerCase();
    if (cleanName.endsWith('.gz')) {
        // Strip out the .gz to find the true extension underneath (e.g., info.log.gz -> log)
        cleanName = cleanName.slice(0, -3);
    }
    const parts = cleanName.split('.');
    return parts.length > 1 ? parts.pop() : 'unknown';
};

app.post('/api/search-content', async (req, res) => {
    const { zipFileName, searchQuery } = req.body;

    if (!zipFileName || !searchQuery) {
        return res.status(400).json({ error: 'Missing zipFileName or search query' });
    }

    const baseUploadsDir = path.resolve(__dirname, 'uploads');
    const absoluteZipPath = path.resolve(baseUploadsDir, zipFileName);

    if (!absoluteZipPath.startsWith(baseUploadsDir) || !fs.existsSync(absoluteZipPath)) {
        return res.status(404).json({ error: 'ZIP file archive not found on server storage.' });
    }

    try {
        const directory = await unzipper.Open.file(absoluteZipPath);
        const searchPattern = searchQuery.toLowerCase().trim();
        const groupedData = {};
        let matchCount = 0;

        // Loop through every single file item indexed within the ZIP archive container
        for (const file of directory.files) {
            // Skip directory structural elements inside the ZIP archive index
            if (file.type === 'Directory') continue;

            const fullInternalPath = file.path.replace(/\\/g, '/');
            const pathParts = fullInternalPath.split('/');
            const fileName = pathParts.pop();
            const nestedDirectory = pathParts.length > 0 ? pathParts.join('/') : 'root';

            // Check match rule 1: Does the search phrase live in the file title itself?
            const isNameMatch = fileName.toLowerCase().includes(searchPattern);
            let isContentMatch = false;
            let textContent = '';

            try {
                // To safely scan file content, extract the compressed data block into memory
                const compressedBuffer = await file.buffer();

                if (fileName.toLowerCase().endsWith('.gz')) {
                    const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
                    textContent = decompressedBuffer.toString('utf-8');
                } else {
                    textContent = compressedBuffer.toString('utf-8');
                }

                // Check match rule 2: Does the search text match anywhere inside the file body data?
                isContentMatch = textContent.toLowerCase().includes(searchPattern);
            } catch (err) {
                // Ignore parsing payload errors for binary assets or corrupted sub-logs
                console.warn(`Skipping content parse for ${file.path}: Not standard text data.`);
            }

            // If either condition matches, format this asset to match your exact frontend schema layout
            if (isNameMatch || isContentMatch) {
                matchCount++;
                const fileExt = getFileExtension(fileName);

                if (!groupedData[fileExt]) {
                    groupedData[fileExt] = [];
                }

                groupedData[fileExt].push({
                    fileName: fileName,
                    nestedDirectory: nestedDirectory,
                    modifiedDate: file.mtime || new Date().toISOString(),
                    zipFileName: zipFileName
                });
            }
        }

        // Re-enforce priority order: Shift '.log' array category to the top position if present
        const sortedGroupedData = {};
        if (groupedData['log']) {
            sortedGroupedData['log'] = groupedData['log'];
        }
        Object.keys(groupedData).forEach(key => {
            if (key !== 'log') {
                sortedGroupedData[key] = groupedData[key];
            }
        });

        return res.json({
            zipFileName: zipFileName,
            message: `Deep content search completed successfully. Found ${matchCount} matching files.`,
            totalFilesFound: matchCount,
            filesByType: sortedGroupedData
        });

    } catch (error) {
        console.error('Deep index content search sequence failed:', error);
        return res.status(500).json({ error: 'Server error tracking search index across zip targets.' });
    }
});

app.post('/api/get-file-list', async (req, res) => {
    const { zipFileName } = req.body;

    if (!zipFileName) {
        return res.status(400).json({ error: 'Missing zipFileName parameter.' });
    }

    const baseUploadsDir = path.resolve(__dirname, 'uploads');
    const absoluteZipPath = path.resolve(baseUploadsDir, zipFileName);

    // 1. Verify the ZIP file archive actually exists on server storage
    if (!absoluteZipPath.startsWith(baseUploadsDir) || !fs.existsSync(absoluteZipPath)) {
        return res.status(404).json({
            exists: false,
            error: 'ZIP file archive not found on server storage.'
        });
    }

    try {
        // 2. Open the ZIP container's central index headers in memory
        const directory = await unzipper.Open.file(absoluteZipPath);
        const groupedData = {};
        let totalFilesCount = 0;

        // 3. Loop through files and format them to match your previous return structure
        directory.files.forEach(file => {
            // Skip directory structural elements inside the ZIP archive index
            if (file.type === 'Directory') return;

            totalFilesCount++;
            const fullInternalPath = file.path.replace(/\\/g, '/');
            const pathParts = fullInternalPath.split('/');
            const fileName = pathParts.pop();
            const nestedDirectory = pathParts.length > 0 ? pathParts.join('/') : 'root';

            const fileExt = getFileExtension(fileName);

            if (!groupedData[fileExt]) {
                groupedData[fileExt] = [];
            }

            groupedData[fileExt].push({
                fileName: fileName,
                nestedDirectory: nestedDirectory,
                modifiedDate: file.mtime || new Date().toISOString(),
                zipFileName: zipFileName
            });
        });

        // 4. Force the '.log' group category to the very top position
        const sortedGroupedData = {};
        if (groupedData['log']) {
            sortedGroupedData['log'] = groupedData['log'];
        }
        Object.keys(groupedData).forEach(key => {
            if (key !== 'log') {
                sortedGroupedData[key] = groupedData[key];
            }
        });

        // 5. Return the exact same schema structure as the original upload endpoint
        return res.status(200).json({
            exists: true,
            zipFileName: zipFileName,
            message: 'Listing all files again!',
            totalFilesFound: totalFilesCount,
            filesByType: sortedGroupedData
        });

    } catch (error) {
        console.error('Error verifying or parsing zip catalog:', error);
        return res.status(500).json({ error: 'Failed to accurately index existing ZIP file structure.' });
    }
});

app.post('/api/delete-zip-files', (req, res) => {
    const { zipFileName } = req.body;

    if (!zipFileName) return res.sendStatus(400);

    const targetPath = path.resolve(__dirname, 'uploads', zipFileName);
    console.log("Attempting to auto-delete ZIP file at path:", targetPath);

    if (fs.existsSync(targetPath)) {
        fs.unlink(targetPath, (err) => {
            if (err) console.error('Failed to auto-delete zip asset:', err);
            else console.log(`Garbage collection: Safely removed ${zipFileName}`);
        });
    }

    // Always send back a quick 200/204 status code immediately
    res.sendStatus(200);
});


// 5. Global Error Handler for Multer/Filter exceptions
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        // A Multer error occurred when uploading (e.g., file too large)
        return res.status(400).json({ error: `Multer Error: ${err.message}` });
    } else if (err) {
        // Our custom file filter error, or other native errors
        return res.status(400).json({ error: err.message });
    }
    next();
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});