const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.BIODL_DATA_DIR || path.join(os.homedir(), '.bio-downloader');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TRANSFERS_FILE = path.join(DATA_DIR, 'transfers.json');

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveSettings(settings) {
  const current = getSettings();
  const updated = { ...current, ...settings };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

function getTransfersData() {
  try {
    if (fs.existsSync(TRANSFERS_FILE)) {
      return JSON.parse(fs.readFileSync(TRANSFERS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { completed: [], failed: [] };
}

function saveTransfersData(data) {
  try {
    const current = getTransfersData();
    const updated = {
      completed: Array.isArray(data?.completed) ? data.completed : current.completed,
      failed: Array.isArray(data?.failed) ? data.failed : current.failed
    };
    const tmp = TRANSFERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmp, TRANSFERS_FILE);
    return updated;
  } catch (e) {
    return { completed: [], failed: [] };
  }
}

module.exports = {
  DATA_DIR,
  SETTINGS_FILE,
  TRANSFERS_FILE,
  getSettings,
  saveSettings,
  getTransfersData,
  saveTransfersData
};
