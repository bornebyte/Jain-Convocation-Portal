require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const userRoutes = require("./routes/userRoutes");
const courseRoutes = require("./routes/courseRoutes");
const requestRoutes = require("./routes/requestRoutes");
const adminRoutes = require("./routes/adminRoutes");
const emailRoutes = require("./routes/emailRoutes");
const cacheRoutes = require("./routes/cacheRoutes");

const app = express();

app.use(cors());
// Set limit to 500KB to account for base64 encoding overhead and other JSON data
app.use(express.json({ limit: "500kb" }));
app.use(express.urlencoded({ limit: "500kb", extended: true }));
app.use(bodyParser.json({ limit: "500kb" }));
app.use(bodyParser.urlencoded({ limit: "500kb", extended: true }));

app.use("/api", userRoutes);
app.use("/api", courseRoutes);
app.use("/api", requestRoutes);
app.use("/api", adminRoutes);
app.use("/api", emailRoutes);
app.use("/api/cache", cacheRoutes);

async function initializeSettings() {
    const { getSettings } = require("./services/settings");
    const { updateSettingsCache } = require("./config/settings");

    try {
        const settings = await getSettings("all");
        updateSettingsCache(settings);
        console.log("Settings cache initialized with all categories");
    } catch (error) {
        console.error("Error initializing settings:", error);
    }
}

initializeSettings();

// On Vercel the app is handled as a serverless function, so only listen when
// running as a standalone server (local development / self-hosted).
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
