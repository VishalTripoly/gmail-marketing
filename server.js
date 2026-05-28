const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for Excel/CSV file upload parsing
const storage = multer.memoryStorage();
const upload = multer({ storage });

const DB_PATH = path.join(__dirname, 'data', 'database.json');
const LOG_FILE_PATH = path.join(__dirname, 'data', 'campaign.log');
const HISTORY_DIR = path.join(__dirname, 'data', 'history');

// Ensure history directory exists
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// Helper for generating short unique IDs
function generateId(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Helper to parse body and inject pixel + wrap links
function wrapEmailBody(body, recipientId, trackingUrl) {
  // Always use at least localhost for tracking (works for local testing)
  const baseUrl = (trackingUrl || 'http://localhost:3000').replace(/\/$/, '');
  
  let html = body;
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  if (!isHtml) {
    // Convert plain text to basic HTML
    html = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
  
  // Safely convert raw URLs to HTML anchor tags without touching existing HTML tags/attributes
  html = html.replace(/<[^>]+>|((https?:\/\/[^\s<"'`]+))/gi, (match, url) => {
    if (url) {
      let cleanUrl = url;
      let trailing = '';
      const trailMatch = url.match(/([.,;:!)]+)$/);
      if (trailMatch) {
        cleanUrl = url.substring(0, url.length - trailMatch[0].length);
        trailing = trailMatch[0];
      }
      return `<a href="${cleanUrl}">${cleanUrl}</a>` + trailing;
    }
    return match;
  });
  
  // Replace links inside href="..." or href='...'
  html = html.replace(/<a\s+([^>]*?)href=(["'])(.*?)\2([^>]*?)>/gi, (match, before, quote, url, after) => {
    if (url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) {
      return match;
    }
    const wrappedUrl = `${baseUrl}/api/track/click/${recipientId}?url=${encodeURIComponent(url)}`;
    return `<a ${before}href="${wrappedUrl}"${after}>`;
  });
  
  // Append 1x1 tracking pixel at the end of the body
  const pixelUrl = `${baseUrl}/api/track/open/${recipientId}`;
  html += `<img src="${pixelUrl}" width="1" height="1" style="display:none !important; width:1px; height:1px;" alt="" />`;
  
  return html;
}

// Global Database State
let db = {
  settings: {
    smtpUser: '',
    smtpPass: '',
    intervalMinutes: 3,
    testEmail: '',
    trackingUrl: ''
  },
  campaign: {
    status: 'IDLE', // IDLE, RUNNING, PAUSED, COMPLETED
    subject: '',
    body: '',
    totalCount: 0,
    sentCount: 0,
    failedCount: 0,
    openedCount: 0,
    clickedCount: 0,
    nextSendTime: null,
    recipients: [],
    logs: []
  }
};

let timerId = null;

// Database Persistence Helpers
function loadDatabase() {
  try {
    if (!fs.existsSync(path.dirname(DB_PATH))) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    }
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(data);
      
      // Deep merge schemas to maintain safety
      db.settings = { ...db.settings, ...parsed.settings };
      db.campaign = { ...db.campaign, ...parsed.campaign };
      
      if (!db.campaign.recipients) db.campaign.recipients = [];
      if (!db.campaign.logs) db.campaign.logs = [];
    } else {
      saveDatabase();
    }
  } catch (err) {
    console.error('Error loading database:', err);
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving database:', err);
  }
}

// Activity Logging Helpers
function addLog(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, type, message };
  
  db.campaign.logs.unshift(logEntry); // Newest first
  if (db.campaign.logs.length > 200) {
    db.campaign.logs.pop();
  }
  
  console.log(`[${type.toUpperCase()}] ${message}`);
  
  try {
    fs.appendFileSync(LOG_FILE_PATH, `[${timestamp}] [${type.toUpperCase()}] ${message}\n`, 'utf8');
  } catch (err) {
    console.error('Failed to write to campaign.log:', err);
  }
  
  saveDatabase();
}

// Helper to archive current campaign run to a history file
function archiveCurrentCampaignRun() {
  try {
    if (!db.campaign.recipients || db.campaign.recipients.length === 0) {
      return;
    }
    
    // Format timestamp nicely for file name
    const date = new Date();
    const formattedDate = date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + '_' +
      String(date.getHours()).padStart(2, '0') + '-' +
      String(date.getMinutes()).padStart(2, '0') + '-' +
      String(date.getSeconds()).padStart(2, '0');
      
    const runId = `run_${formattedDate}`;
    const runFilePath = path.join(HISTORY_DIR, `${runId}.json`);
    
    const runData = {
      runId,
      timestamp: date.toISOString(),
      subject: db.campaign.subject || '',
      body: db.campaign.body || '',
      totalCount: db.campaign.totalCount || 0,
      sentCount: db.campaign.sentCount || 0,
      failedCount: db.campaign.failedCount || 0,
      openedCount: db.campaign.openedCount || 0,
      clickedCount: db.campaign.clickedCount || 0,
      recipients: db.campaign.recipients
    };
    
    fs.writeFileSync(runFilePath, JSON.stringify(runData, null, 2), 'utf8');
    addLog(`Campaign run archived successfully: ${runId}`, 'info');
  } catch (err) {
    console.error('Failed to archive campaign run:', err);
  }
}

// Helper to format recipients list to a CSV string
function generateCSV(recipients) {
  if (recipients.length === 0) return '';
  
  const dataKeys = new Set();
  recipients.forEach(r => {
    if (r.data) {
      Object.keys(r.data).forEach(k => {
        const val = String(r.data[k] || '').trim();
        const keyLower = k.toLowerCase().trim();
        
        const isNameDuplicate = (k === r.nameKey) || 
          (val === r.name && (keyLower === 'name' || keyLower === 'client name' || keyLower === 'fullname' || keyLower === 'contact' || keyLower === 'first name' || keyLower === 'last name'));
          
        const isEmailDuplicate = (k === r.emailKey) || 
          (val === r.email && (keyLower === 'email' || keyLower === 'email id' || keyLower === 'emailid' || keyLower === 'mail' || keyLower === 'mail id' || keyLower === 'mailid'));

        if (!isNameDuplicate && !isEmailDuplicate) {
          dataKeys.add(k);
        }
      });
    }
  });
  const sortedDataKeys = Array.from(dataKeys);
  
  const headers = [
    'Index',
    'Name',
    'Email',
    'Status',
    'Sent At',
    'Opened',
    'Opened At',
    'Opens Count',
    'Clicks Count',
    'Click Details',
    'Error',
    ...sortedDataKeys
  ];
  
  const escapeCSV = (str) => {
    if (str === null || str === undefined) return '';
    const val = String(str).replace(/"/g, '""');
    if (val.includes(',') || val.includes('\n') || val.includes('\r') || val.includes('"')) {
      return `"${val}"`;
    }
    return val;
  };
  
  const rows = [headers.map(escapeCSV).join(',')];
  
  recipients.forEach((r, idx) => {
    const clicksDetailStr = (r.clicks || []).map((c, cIdx) => {
      return `#${cIdx + 1}: ${c.url} @ ${c.clickedAt}`;
    }).join('; ');
    
    const rowValues = [
      idx + 1,
      r.name,
      r.email,
      r.status,
      r.sentAt || '',
      r.opened ? 'Yes' : 'No',
      r.openedAt || '',
      r.opensCount || 0,
      (r.clicks || []).length,
      clicksDetailStr,
      r.error || ''
    ];
    
    sortedDataKeys.forEach(k => {
      rowValues.push(r.data ? (r.data[k] || '') : '');
    });
    
    rows.push(rowValues.map(escapeCSV).join(','));
  });
  
  return rows.join('\r\n');
}

// Email Campaign Sender Logic
async function sendNextEmail() {
  if (db.campaign.status !== 'RUNNING') {
    return;
  }
  
  // Find the first recipient who is PENDING
  const recipientIndex = db.campaign.recipients.findIndex(r => r.status === 'PENDING');
  
  if (recipientIndex === -1) {
    // All recipients processed — stop everything, never loop again
    if (timerId) { clearTimeout(timerId); timerId = null; }
    db.campaign.status = 'COMPLETED';
    db.campaign.nextSendTime = null;
    saveDatabase();
    archiveCurrentCampaignRun();
    addLog('🎉 Campaign completed! All recipients have been processed. Campaign has stopped.', 'success');
    return;
  }
  
  const recipient = db.campaign.recipients[recipientIndex];
  recipient.status = 'PROCESSING';
  saveDatabase();
  
  // Template custom substitutions
  let customizedSubject = db.campaign.subject;
  let customizedBody = db.campaign.body;
  
  const placeholders = {
    Name: recipient.name,
    Email: recipient.email,
    ...recipient.data
  };
  
  // Replace custom placeholders format: {{Placeholder}}
  for (const [key, value] of Object.entries(placeholders)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
    customizedSubject = customizedSubject.replace(regex, value || '');
    customizedBody = customizedBody.replace(regex, value || '');
  }
  
  // Wrap body with open & link click tracking if configured
  const wrappedHtmlBody = wrapEmailBody(customizedBody, recipient.id, db.settings.trackingUrl);
  
  // Configure SMTP Transporter for Gmail
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: db.settings.smtpUser,
      pass: db.settings.smtpPass
    }
  });
  
  try {
    addLog(`Sending email to ${recipient.name} <${recipient.email}>...`, 'info');
    
    const mailOptions = {
      from: `"${db.settings.smtpUser.split('@')[0]}" <${db.settings.smtpUser}>`,
      to: recipient.email,
      subject: customizedSubject,
      html: wrappedHtmlBody  // Always send as HTML so tracking pixel renders
    };
    
    await transporter.sendMail(mailOptions);
    
    recipient.status = 'SENT';
    recipient.sentAt = new Date().toISOString();
    recipient.error = null;
    db.campaign.sentCount++;
    addLog(`✓ Email successfully sent to ${recipient.name} <${recipient.email}>`, 'success');
  } catch (error) {
    recipient.status = 'FAILED';
    recipient.sentAt = new Date().toISOString();
    recipient.error = error.message;
    db.campaign.failedCount++;
    addLog(`✗ Failed to send email to ${recipient.name} <${recipient.email}>: ${error.message}`, 'error');
  }
  
  saveDatabase();
  
  // Only schedule next send if campaign is still RUNNING and there are more PENDING recipients
  if (db.campaign.status === 'RUNNING') {
    const hasPending = db.campaign.recipients.some(r => r.status === 'PENDING');
    if (hasPending) {
      const delayMs = db.settings.intervalMinutes * 60 * 1000;
      scheduleNextSend(delayMs);
    } else {
      // No more pending — mark completed immediately
      if (timerId) { clearTimeout(timerId); timerId = null; }
      db.campaign.status = 'COMPLETED';
      db.campaign.nextSendTime = null;
      saveDatabase();
      archiveCurrentCampaignRun();
      addLog('🎉 Campaign completed! All recipients have been processed. Campaign has stopped.', 'success');
    }
  }
}

function scheduleNextSend(delayMs) {
  if (timerId) clearTimeout(timerId);
  db.campaign.nextSendTime = Date.now() + delayMs;
  saveDatabase();
  
  timerId = setTimeout(async () => {
    await sendNextEmail();
  }, delayMs);
}

// Startup Recovery Mechanism
function resumeCampaignIfNeeded() {
  loadDatabase();
  
  if (db.campaign.status === 'RUNNING') {
    addLog('Server restarted. Resuming active marketing campaign...', 'info');
    const now = Date.now();
    const nextSend = db.campaign.nextSendTime || now;
    const delay = Math.max(0, nextSend - now);
    
    addLog(`Next schedule sending triggered in ${Math.round(delay / 1000)} seconds.`, 'info');
    scheduleNextSend(delay);
  }
}

// API Route: Retrieve Campaign Status & Active Queue
app.get('/api/campaign/status', (req, res) => {
  const responseData = {
    status: db.campaign.status,
    settings: {
      smtpUser: db.settings.smtpUser,
      smtpPass: db.settings.smtpPass ? '********' : '',
      intervalMinutes: db.settings.intervalMinutes,
      testEmail: db.settings.testEmail,
      trackingUrl: db.settings.trackingUrl || ''
    },
    campaign: {
      subject: db.campaign.subject,
      body: db.campaign.body,
      totalCount: db.campaign.totalCount,
      sentCount: db.campaign.sentCount,
      failedCount: db.campaign.failedCount,
      openedCount: db.campaign.openedCount || 0,
      clickedCount: db.campaign.clickedCount || 0,
      nextSendTime: db.campaign.nextSendTime,
      recipients: db.campaign.recipients,
      logs: db.campaign.logs
    }
  };
  res.json(responseData);
});

// API Route: Save Configuration
app.post('/api/settings', (req, res) => {
  const { smtpUser, smtpPass, intervalMinutes, testEmail, trackingUrl } = req.body;
  
  if (smtpUser !== undefined) db.settings.smtpUser = smtpUser;
  
  // Do not overwrite existing password with dummy mask value
  if (smtpPass && smtpPass !== '********') {
    db.settings.smtpPass = smtpPass;
  }
  
  if (intervalMinutes !== undefined) {
    db.settings.intervalMinutes = Math.max(0.05, parseFloat(intervalMinutes)); // minimum 3 seconds for fast testing, default 3-5m
  }
  
  if (testEmail !== undefined) db.settings.testEmail = testEmail;
  if (trackingUrl !== undefined) db.settings.trackingUrl = trackingUrl.trim();
  
  saveDatabase();
  res.json({ success: true, settings: {
    smtpUser: db.settings.smtpUser,
    smtpPass: db.settings.smtpPass ? '********' : '',
    intervalMinutes: db.settings.intervalMinutes,
    testEmail: db.settings.testEmail,
    trackingUrl: db.settings.trackingUrl || ''
  }});
});

// API Route: Verify SMTP Connection credentials
app.post('/api/test-connection', async (req, res) => {
  const { smtpUser, smtpPass, testEmail } = req.body;
  
  const user = smtpUser || db.settings.smtpUser;
  const pass = (smtpPass && smtpPass !== '********') ? smtpPass : db.settings.smtpPass;
  const toEmail = testEmail || db.settings.testEmail || user;
  
  if (!user || !pass) {
    return res.status(400).json({ error: 'Gmail user address and App Password credentials are required.' });
  }
  
  if (!toEmail) {
    return res.status(400).json({ error: 'Recipient address for the test email is required.' });
  }
  
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass }
  });
  
  try {
    addLog(`Testing SMTP credentials connection for ${user}...`, 'info');
    await transporter.verify();
    
    // Dispatch check email
    await transporter.sendMail({
      from: `"${user.split('@')[0]}" <${user}>`,
      to: toEmail,
      subject: 'Gmail Marketing System - Connection Test Successful',
      text: `Hello!\n\nThis is a verification check from your Gmail Marketing application. Your SMTP connections are working properly!\n\nVerified at: ${new Date().toLocaleString()}`
    });
    
    addLog(`✓ SMTP test verified. Test email dispatched to ${toEmail}.`, 'success');
    res.json({ success: true, message: `Successfully connected to Gmail SMTP and sent test email to ${toEmail}.` });
  } catch (error) {
    console.error('SMTP testing failure:', error);
    res.status(500).json({ 
      error: error.message,
      detail: 'Troubleshooting steps:\n1. Verify if 2-Step Verification is activated in your Gmail Account Security settings.\n2. Ensure you have generated a custom 16-character App Password (not your standard password).\n3. Re-check the typed Gmail address.'
    });
  }
});

// API Route: Process Excel or CSV Recipient sheets
app.post('/api/upload-recipients', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please choose and upload a sheet file.' });
    }
    
    // Read the file buffer (supports XLS, XLSX, CSV natively in sheetjs)
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // Convert worksheet rows to array of JSON objects
    const rawRows = xlsx.utils.sheet_to_json(worksheet);
    
    if (rawRows.length === 0) {
      return res.status(400).json({ error: 'The uploaded file is empty or cannot be parsed.' });
    }
    
    // Auto-detect Name and Email column mappings
    const keys = Object.keys(rawRows[0]);
    let emailKey = null;
    let nameKey = null;
    
    for (const key of keys) {
      if (!emailKey && /email|mail/i.test(key)) emailKey = key;
      if (!nameKey && /name|fullname|contact/i.test(key)) nameKey = key;
    }
    
    if (!emailKey) {
      return res.status(400).json({ 
        error: 'No column matched "Email". Ensure a column named "Email" or "Mail" is defined as a header.' 
      });
    }
    
    // Map rows to queue entities
    const recipients = [];
    for (const row of rawRows) {
      const email = String(row[emailKey] || '').trim();
      if (!email) continue; // Skip blank fields
      
      const name = nameKey ? String(row[nameKey] || '').trim() : 'Subscriber';
      
      // Retain full record data to feed customizable templates
      const data = {};
      for (const [k, v] of Object.entries(row)) {
        data[k] = String(v || '').trim();
      }
      
      const id = generateId();
      recipients.push({
        id,
        name,
        email,
        status: 'PENDING',
        sentAt: null,
        error: null,
        opened: false,
        openedAt: null,
        opensCount: 0,
        clicks: [],
        data,
        nameKey,
        emailKey
      });
    }
    
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipient contacts with valid emails were found.' });
    }
    
    // Archive previous campaign if there was sending activity
    if (db.campaign.recipients && db.campaign.recipients.length > 0 && (db.campaign.sentCount > 0 || db.campaign.failedCount > 0)) {
      archiveCurrentCampaignRun();
    }
    
    // Cancel any active schedulers and reset campaign queue
    if (timerId) clearTimeout(timerId);
    db.campaign.status = 'IDLE';
    db.campaign.totalCount = recipients.length;
    db.campaign.sentCount = 0;
    db.campaign.failedCount = 0;
    db.campaign.nextSendTime = null;
    db.campaign.recipients = recipients;
    db.campaign.logs = [];
    
    addLog(`Uploaded ${recipients.length} recipients from "${req.file.originalname}" (Auto-detected email column: "${emailKey}", name column: "${nameKey || 'None'}").`, 'info');
    
    saveDatabase();
    res.json({ success: true, count: recipients.length });
  } catch (error) {
    console.error('File parsing error:', error);
    res.status(500).json({ error: 'Error processing database upload sheet: ' + error.message });
  }
});

// API Route: Initiate or Resume Campaign
app.post('/api/campaign/start', (req, res) => {
  const { subject, body } = req.body;
  
  if (!db.settings.smtpUser || !db.settings.smtpPass) {
    return res.status(400).json({ error: 'Gmail connection settings are not configured yet.' });
  }
  
  if (db.campaign.recipients.length === 0) {
    return res.status(400).json({ error: 'The campaign recipient queue is empty. Upload a CSV/Excel sheet first.' });
  }
  
  if (!subject || !body) {
    return res.status(400).json({ error: 'Please enter a Subject and Email Body to proceed.' });
  }
  
  db.campaign.subject = subject;
  db.campaign.body = body;
  
  if (db.campaign.status === 'IDLE' || db.campaign.status === 'COMPLETED') {
    db.campaign.sentCount = 0;
    db.campaign.failedCount = 0;
    db.campaign.openedCount = 0;
    db.campaign.clickedCount = 0;
    db.campaign.recipients.forEach(r => {
      r.status = 'PENDING';
      r.sentAt = null;
      r.error = null;
      r.opened = false;
      r.openedAt = null;
      r.opensCount = 0;
      r.clicks = [];
    });
    db.campaign.logs = [];
    addLog('Starting new email campaign deployment...', 'info');
  } else if (db.campaign.status === 'PAUSED') {
    addLog('Resuming current paused email campaign...', 'info');
  }
  
  db.campaign.status = 'RUNNING';
  saveDatabase();
  
  // Trigger immediate dispatch of the first queued email
  sendNextEmail();
  
  res.json({ success: true });
});

// API Route: Pause Campaign
app.post('/api/campaign/stop', (req, res) => {
  if (timerId) clearTimeout(timerId);
  db.campaign.status = 'PAUSED';
  db.campaign.nextSendTime = null;
  addLog('Campaign paused by the operator.', 'info');
  saveDatabase();
  res.json({ success: true });
});

// API Route: Reset Campaign Queue and metrics
app.post('/api/campaign/reset', (req, res) => {
  if (timerId) clearTimeout(timerId);
  db.campaign.status = 'IDLE';
  db.campaign.nextSendTime = null;
  db.campaign.sentCount = 0;
  db.campaign.failedCount = 0;
  db.campaign.openedCount = 0;
  db.campaign.clickedCount = 0;
  db.campaign.recipients.forEach(r => {
    r.status = 'PENDING';
    r.sentAt = null;
    r.error = null;
    r.opened = false;
    r.openedAt = null;
    r.opensCount = 0;
    r.clicks = [];
  });
  db.campaign.logs = [];
  addLog('Campaign settings and recipient queue metrics have been reset.', 'info');
  saveDatabase();
  res.json({ success: true });
});

// API Route: Clear Campaign Recipients entirely
app.post('/api/campaign/clear', (req, res) => {
  // Archive previous campaign if there was sending activity
  if (db.campaign.recipients && db.campaign.recipients.length > 0 && (db.campaign.sentCount > 0 || db.campaign.failedCount > 0)) {
    archiveCurrentCampaignRun();
  }
  
  if (timerId) clearTimeout(timerId);
  db.campaign.status = 'IDLE';
  db.campaign.nextSendTime = null;
  db.campaign.totalCount = 0;
  db.campaign.sentCount = 0;
  db.campaign.failedCount = 0;
  db.campaign.openedCount = 0;
  db.campaign.clickedCount = 0;
  db.campaign.recipients = [];
  db.campaign.logs = [];
  addLog('Campaign recipient list cleared.', 'info');
  saveDatabase();
  res.json({ success: true });
});

// API Route: Export Current Campaign Report (CSV)
app.get('/api/campaign/export', (req, res) => {
  try {
    const recipients = db.campaign.recipients || [];
    if (recipients.length === 0) {
      return res.status(400).send('No recipient data available to export.');
    }
    const csv = generateCSV(recipients);
    const date = new Date();
    const formattedDate = date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + '_' +
      String(date.getHours()).padStart(2, '0') + '-' +
      String(date.getMinutes()).padStart(2, '0') + '-' +
      String(date.getSeconds()).padStart(2, '0');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=campaign_report_${formattedDate}.csv`);
    res.status(200).send(csv);
  } catch (error) {
    res.status(500).send('Export failed: ' + error.message);
  }
});

// API Route: List All History Runs
app.get('/api/history', (req, res) => {
  try {
    if (!fs.existsSync(HISTORY_DIR)) {
      return res.json([]);
    }
    const files = fs.readdirSync(HISTORY_DIR).filter(file => file.endsWith('.json'));
    const historyList = [];
    
    for (const file of files) {
      try {
        const filePath = path.join(HISTORY_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const run = JSON.parse(content);
        historyList.push({
          runId: run.runId,
          timestamp: run.timestamp,
          subject: run.subject,
          totalCount: run.totalCount,
          sentCount: run.sentCount,
          failedCount: run.failedCount,
          openedCount: run.openedCount,
          clickedCount: run.clickedCount
        });
      } catch (e) {
        console.error(`Error reading history file ${file}:`, e);
      }
    }
    
    // Newest first
    historyList.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(historyList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API Route: Export a Specific Past Run from History (CSV)
app.get('/api/history/export/:runId', (req, res) => {
  try {
    const { runId } = req.params;
    const safeRunId = path.basename(runId);
    const filePath = path.join(HISTORY_DIR, `${safeRunId}.json`);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('History campaign run not found.');
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const run = JSON.parse(content);
    const csv = generateCSV(run.recipients);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=campaign_${safeRunId}_report.csv`);
    res.status(200).send(csv);
  } catch (error) {
    res.status(500).send('Export failed: ' + error.message);
  }
});

// ==========================================================================
// API Tracking Routes (Opens & Link Clicks)
// ==========================================================================

const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Endpoint: Track Email Open
app.get('/api/track/open/:recipientId', (req, res) => {
  const { recipientId } = req.params;
  
  const recipient = db.campaign.recipients.find(r => r.id === recipientId);
  if (recipient) {
    if (!recipient.opened) {
      recipient.opened = true;
      recipient.openedAt = new Date().toISOString();
      db.campaign.openedCount = (db.campaign.openedCount || 0) + 1;
      addLog(`[Track] Email opened by ${recipient.name} <${recipient.email}>`, 'success');
    }
    recipient.opensCount = (recipient.opensCount || 0) + 1;
    saveDatabase();
  }
  
  // Deliver base64 1x1 transparent tracking pixel image
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': TRANSPARENT_GIF.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private, post-check=0, pre-check=0'
  });
  res.end(TRANSPARENT_GIF);
});

// Endpoint: Track Wrapped Link Click Redirect
app.get('/api/track/click/:recipientId', (req, res) => {
  const { recipientId } = req.params;
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).send('Error: Link redirect target URL query is missing.');
  }
  
  const recipient = db.campaign.recipients.find(r => r.id === recipientId);
  if (recipient) {
    if (!recipient.clicks) recipient.clicks = [];
    recipient.clicks.push({
      url: targetUrl,
      clickedAt: new Date().toISOString()
    });
    
    const isFirstClick = recipient.clicks.length === 1;
    if (isFirstClick) {
      db.campaign.clickedCount = (db.campaign.clickedCount || 0) + 1;
    }
    
    addLog(`[Track] Link clicked by ${recipient.name} <${recipient.email}>: ${targetUrl}`, 'success');
    saveDatabase();
  }
  
  res.redirect(targetUrl);
});

// Load DB configurations and resume operations if recovery is needed
resumeCampaignIfNeeded();

// Start Listener
app.listen(PORT, () => {
  console.log(`Gmail Marketing application engine running on port ${PORT}`);
});
