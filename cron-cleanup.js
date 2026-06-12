const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const baseUploadsDir = path.resolve(__dirname, 'uploads');

const purgeAllUploads = () => {
    console.log(`[CRON] Starting absolute storage wipe at ${new Date().toISOString()}`);

    if (!fs.existsSync(baseUploadsDir)) {
        // If the uploads directory doesn't exist, create it and exit
        fs.mkdirSync(baseUploadsDir, { recursive: true });
        return;
    }

    try {
        // 1. Read all files/folders inside the uploads directory
        const items = fs.readdirSync(baseUploadsDir);

        items.forEach(item => {
            const itemPath = path.join(baseUploadsDir, item);

            try {
                // 2. Force delete files and sub-folders recursively
                fs.rmSync(itemPath, { recursive: true, force: true });
                console.log(`[CRON] Eradicated asset: ${item}`);
            } catch (fileError) {
                console.error(`[CRON] Windows file-lock blocked deletion for ${item}:`, fileError.message);
            }
        });

        console.log('[CRON] Uploads folder purge complete.');

    } catch (dirError) {
        console.error('[CRON] Critical error during folder wipe routine:', dirError);
    }
};

// Scheduled to run every single day at exactly 20:00 PM
cron.schedule('0 20 * * *', () => {
    purgeAllUploads();
});

console.log('[CRON] Hard-wipe scheduler initialized for 20:00 PM daily.');