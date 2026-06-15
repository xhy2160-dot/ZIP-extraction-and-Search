const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const baseUploadsDir = path.resolve(__dirname, 'uploads');
// 2 hours in milliseconds (2 hours * 60 mins * 60 secs * 1000 ms)
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const purgeExpiredUploads = () => {
    console.log(`[CRON] Running hourly retention check at ${new Date().toISOString()}`);

    if (!fs.existsSync(baseUploadsDir)) {
        fs.mkdirSync(baseUploadsDir, { recursive: true });
        return;
    }

    try {
        const items = fs.readdirSync(baseUploadsDir);
        const now = Date.now();
        let deletedCount = 0;

        items.forEach(item => {
            const itemPath = path.join(baseUploadsDir, item);

            try {
                // Get file/folder metadata stats
                const stats = fs.statSync(itemPath);
                const fileAge = now - stats.mtimeMs;

                // Only delete if the asset is older than 2 hours
                if (fileAge > MAX_AGE_MS) {
                    fs.rmSync(itemPath, { recursive: true, force: true });
                    console.log(`[CRON] Eradicated expired asset: ${item} (Age: ${Math.round(fileAge / 1000 / 60)} mins)`);
                    deletedCount++;
                }
            } catch (fileError) {
                console.error(`[CRON] Windows file-lock or permission issue blocked checking/deleting ${item}:`, fileError.message);
            }
        });

        console.log(`[CRON] Hourly check complete. Purged ${deletedCount} expired assets.`);

    } catch (dirError) {
        console.error('[CRON] Critical error during folder wipe routine:', dirError);
    }
};

// '0 * * * *' matches minute 0 of every single hour (1:00, 2:00, 3:00, etc.)
cron.schedule('0 * * * *', () => {
    purgeExpiredUploads();
});

console.log('[CRON] Hourly retention scheduler initialized (Files older than 2 hours will be purged).');