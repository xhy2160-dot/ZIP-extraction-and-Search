const AdmZip = require('adm-zip');
const path = require('path');

/**
 * Recursively parses a ZIP file (including nested ZIPs) into a flat list.
 * * @param {string|Buffer} fileSource - Path to the ZIP file or a Buffer containing ZIP data.
 * @param {string} currentDir - Tracks the nested directory path structure.
 * @param {Array} fileList - Accumulator for the flat list of files.
 */
function parseZipRecursive(fileSource, currentDir = '', fileList = []) {
    try {
        let zip;

        if (Buffer.isBuffer(fileSource)) {
            zip = new AdmZip(fileSource);
        } else {
            zip = new AdmZip(fileSource);
        }

        const zipEntries = zip.getEntries();

        for (const entry of zipEntries) {
            // Skip directory entries themselves, we only care about files
            if (entry.isDirectory) continue;

            const fileName = path.basename(entry.entryName);
            // Resolve the nested directory path within the archive structure
            const entryDir = path.dirname(entry.entryName);
            const nestedDirectory = currentDir
                ? path.join(currentDir, entryDir === '.' ? '' : entryDir)
                : (entryDir === '.' ? 'root' : entryDir);

            const fileExtension = path.extname(fileName).toLowerCase() || 'no-extension';

            // 1. Check if the nested file is *another* ZIP file
            if (fileExtension === '.zip') {
                const nestedZipBuffer = entry.getData(); // Read the inner zip into memory
                const deeperDir = currentDir ? path.join(currentDir, entry.entryName) : entry.entryName;

                // Recurse into the nested ZIP
                parseZipRecursive(nestedZipBuffer, deeperDir, fileList);
            } else {
                // 2. It's a standard file, push its metadata to our flat list
                fileList.push({
                    fileName: fileName,
                    nestedDirectory: nestedDirectory.replace(/\\/g, '/'), // Standardize slashes
                    modifiedDate: entry.header.time, // Date object from zip header
                    fileType: fileExtension.replace('.', '') // e.g., 'pdf', 'png'
                });
            }
        }
    } catch (error) {
        console.error(`Error processing ZIP layer at [${currentDir || 'root'}]:`, error.message);
    }

    return fileList;
}

/**
 * Groups a flat list of files by their file extension type.
 * @param {Array} flatList 
 */
function groupByFileType(flatList) {
    return flatList.reduce((groups, file) => {
        const type = file.fileType;
        if (!groups[type]) {
            groups[type] = [];
        }
        groups[type].push({
            fileName: file.fileName,
            nestedDirectory: file.nestedDirectory,
            modifiedDate: file.modifiedDate
        });
        return groups;
    }, {});
}

module.exports = {
    parseZipRecursive,
    groupByFileType
};