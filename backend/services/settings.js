const db = require("../config/firebase");
const { cache, TTL } = require("../config/cache");
const { updateSettingsCache } = require("../config/settings");
const { invalidateCache } = require("../utils/cache.utils");

// Function to get settings from firestore
const getSettings = async (category = "all") => {
    const cacheKey = `settings_${category}`;
    const cachedSettings = await cache.get(cacheKey);

    if (cachedSettings) {
        console.log(`📦 Serving cached settings for category: ${category}`);
        return cachedSettings;
    }

    try {
        let settings;
        if (category === "all") {
            const snapshot = await db.collection("settings").get();
            settings = {};
            snapshot.forEach((doc) => settings[doc.id] = doc.data());
        } else {
            const doc = await db.collection("settings").doc(category).get();
            settings = { [category]: doc.exists ? doc.data() : {} };
        }
        
        await cache.set(cacheKey, settings, TTL.SETTINGS);
        updateSettingsCache(settings); // Update in-memory cache as well
        return settings;
    } catch (error) {
        console.error('Error fetching settings:', error);
        throw error;
    }
};

// Function to update settings
const updateSettings = async (settings) => {
    const batch = db.batch();

    // Update each category
    for (const [category, categorySettings] of Object.entries(settings)) {
        const docRef = db.collection("settings").doc(category);
        await invalidateCache(`settings`, category);
        batch.set(docRef, categorySettings);
    }

    await batch.commit();
    updateSettingsCache(settings); // Update cache after successful save
    // await invalidateCache("settings");
    return { success: true };
};

const bumpGalleryRefreshStamp = async () => {
    const docRef = db.collection('settings').doc('config');
    const snapshot = await docRef.get();
    const currentStamp = Number(snapshot.exists ? snapshot.data().GALLERY_REFRESH_TIMESTAMP : 0) || 0;
    const stamp = Math.max(Date.now(), currentStamp + 1);

    await docRef.set({ GALLERY_REFRESH_TIMESTAMP: stamp }, { merge: true });
    await invalidateCache('settings', 'config');
    updateSettingsCache({ config: { GALLERY_REFRESH_TIMESTAMP: stamp } });

    return stamp;
};

module.exports = {
    getSettings,
    updateSettings,
    bumpGalleryRefreshStamp,
};
