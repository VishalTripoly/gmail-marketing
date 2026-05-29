const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3050;

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
  const baseUrl = (trackingUrl || 'http://localhost:3000').replace(/\/$/, '');
  
  let html = body;
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  if (!isHtml) {
    html = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
  
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
  
  html = html.replace(/<a\s+([^>]*?)href=(["'])(.*?)\2([^>]*?)>/gi, (match, before, quote, url, after) => {
    if (url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) {
      return match;
    }
    const wrappedUrl = `${baseUrl}/api/track/click/${recipientId}?url=${encodeURIComponent(url)}`;
    return `<a ${before}href="${wrappedUrl}"${after}>`;
  });
  
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
  campaigns: {}
};

// Database Persistence Helpers
function loadDatabase() {
  try {
    if (!fs.existsSync(path.dirname(DB_PATH))) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    }
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(data);
      
      db.settings = { ...db.settings, ...parsed.settings };
      db.campaigns = parsed.campaigns || {};
      
      // Migrate old campaign object if present
      if (parsed.campaign && Object.keys(parsed.campaign).length > 0) {
        const today = new Date();
        const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        if (!db.campaigns[dateStr]) {
          db.campaigns[dateStr] = parsed.campaign;
        }
      }
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

// Helper to get or create campaign for a specific date
function getCampaignForDate(dateStr) {
  if (!dateStr) {
    const today = new Date();
    dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  }
  if (!db.campaigns) db.campaigns = {};
  if (!db.campaigns[dateStr]) {
    db.campaigns[dateStr] = {
      status: 'IDLE',
      subject: '',
      body: '',
      scheduleEnabled: false,
      scheduleTime: '09:00',
      scheduleAllowedStart: '09:00',
      scheduleAllowedEnd: '18:00',
      scheduleDays: [1, 2, 3, 4, 5],
      totalCount: 0,
      sentCount: 0,
      failedCount: 0,
      openedCount: 0,
      clickedCount: 0,
      nextSendTime: null,
      recipients: [],
      logs: []
    };
  }
  return db.campaigns[dateStr];
}

// Helper to mark duplicate email addresses as DELETED so they are not sent emails
function deduplicateRecipients(campaign) {
  if (!campaign || !campaign.recipients) return;
  const seen = new Set();
  let duplicateCount = 0;
  campaign.recipients.forEach(r => {
    const emailLower = r.email.toLowerCase();
    if (seen.has(emailLower)) {
      if (r.status === 'PENDING') {
        r.status = 'DELETED';
        duplicateCount++;
      }
    } else {
      seen.add(emailLower);
      if (r.status === 'DELETED') {
        r.status = 'PENDING';
      }
    }
  });
  if (duplicateCount > 0) {
    addCampaignLog(campaign, `Identified and marked ${duplicateCount} duplicate email(s) as DELETED.`, 'info');
  }
}

// Campaign-specific logging helper
function addCampaignLog(campaign, message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, type, message };
  
  if (!campaign.logs) campaign.logs = [];
  campaign.logs.unshift(logEntry);
  if (campaign.logs.length > 200) {
    campaign.logs.pop();
  }
  
  console.log(`[${type.toUpperCase()}] ${message}`);
  
  try {
    fs.appendFileSync(LOG_FILE_PATH, `[${timestamp}] [${type.toUpperCase()}] ${message}\n`, 'utf8');
  } catch (err) {
    console.error('Failed to write to campaign.log:', err);
  }
  
  saveDatabase();
}

// Archive Campaign Run
function archiveCampaignRun(campaign, dateStr) {
  try {
    if (!campaign.recipients || campaign.recipients.length === 0) {
      return;
    }
    const date = new Date();
    const formattedDate = date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + '_' +
      String(date.getHours()).padStart(2, '0') + '-' +
      String(date.getMinutes()).padStart(2, '0') + '-' +
      String(date.getSeconds()).padStart(2, '0');
      
    const runId = `run_${dateStr}_${formattedDate}`;
    const runFilePath = path.join(HISTORY_DIR, `${runId}.json`);
    
    const runData = {
      runId,
      timestamp: date.toISOString(),
      subject: campaign.subject || '',
      body: campaign.body || '',
      totalCount: campaign.totalCount || 0,
      sentCount: campaign.sentCount || 0,
      failedCount: campaign.failedCount || 0,
      openedCount: campaign.openedCount || 0,
      clickedCount: campaign.clickedCount || 0,
      recipients: campaign.recipients
    };
    
    fs.writeFileSync(runFilePath, JSON.stringify(runData, null, 2), 'utf8');
    addCampaignLog(campaign, `Campaign run archived successfully: ${runId}`, 'info');
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

        const isCompanyKey = keyLower === 'company' || keyLower === 'company name' || keyLower === 'client company';
        const isCityKey = keyLower === 'city' || keyLower === 'location';
        const isTypeKey = keyLower === 'client type' || keyLower === 'type' || keyLower === 'customer type';

        if (!isNameDuplicate && !isEmailDuplicate && !isCompanyKey && !isCityKey && !isTypeKey) {
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
    'Company',
    'City',
    'Client Type',
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
    
    let companyVal = '';
    let cityVal = '';
    let clientTypeVal = '';
    
    if (r.data) {
      const companyKey = Object.keys(r.data).find(k => /company/i.test(k));
      if (companyKey) companyVal = r.data[companyKey] || '';
      
      const cityKey = Object.keys(r.data).find(k => /city/i.test(k));
      if (cityKey) cityVal = r.data[cityKey] || '';
      
      const typeKey = Object.keys(r.data).find(k => /type/i.test(k));
      if (typeKey) clientTypeVal = r.data[typeKey] || '';
    }

    const rowValues = [
      idx + 1,
      r.name,
      r.email,
      companyVal,
      cityVal,
      clientTypeVal,
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

// Helper to check and calculate scheduling delays
function getNextValidScheduleDelayForCampaign(campaign, dateStr) {
  if (!campaign.scheduleEnabled) {
    return 0;
  }
  
  const now = new Date();
  let target = new Date();
  
  // Parse calendar date
  const [year, month, day] = dateStr.split('-').map(Number);
  const calendarDate = new Date(year, month - 1, day);
  
  if (calendarDate > target) {
    target = calendarDate;
  }
  
  if (campaign.scheduleTime) {
    const [startH, startM] = campaign.scheduleTime.split(':').map(Number);
    const startDateTime = new Date(calendarDate);
    startDateTime.setHours(startH, startM, 0, 0);
    if (startDateTime > target) {
      target = startDateTime;
    }
  }
  
  const [startH, startM] = (campaign.scheduleAllowedStart || '09:00').split(':').map(Number);
  const [endH, endM] = (campaign.scheduleAllowedEnd || '18:00').split(':').map(Number);
  const allowedDays = campaign.scheduleDays || [1, 2, 3, 4, 5];
  
  for (let i = 0; i < 10; i++) {
    const testDate = new Date(target.getTime() + i * 24 * 60 * 60 * 1000);
    
    if (i > 0) {
      testDate.setHours(startH, startM, 0, 0);
    }
    
    const dayOfWeek = testDate.getDay();
    if (!allowedDays.includes(dayOfWeek)) {
      continue;
    }
    
    const startOfWindow = new Date(testDate);
    startOfWindow.setHours(startH, startM, 0, 0);
    
    const endOfWindow = new Date(testDate);
    endOfWindow.setHours(endH, endM, 0, 0);
    
    if (testDate < startOfWindow) {
      const delay = startOfWindow.getTime() - now.getTime();
      return Math.max(0, delay);
    } else if (testDate >= startOfWindow && testDate <= endOfWindow) {
      const delay = testDate.getTime() - now.getTime();
      return Math.max(0, delay);
    } else {
      continue;
    }
  }
  
  return 0;
}

// Background Dispatcher Loop
async function processRunningCampaigns() {
  const now = Date.now();
  if (!db.campaigns) return;
  
  for (const dateStr of Object.keys(db.campaigns)) {
    const campaign = db.campaigns[dateStr];
    if (campaign.status !== 'RUNNING') continue;
    
    if (campaign.nextSendTime && now < campaign.nextSendTime) {
      continue;
    }
    
    const delayMs = getNextValidScheduleDelayForCampaign(campaign, dateStr);
    if (delayMs > 0) {
      const wakeUpTime = new Date(Date.now() + delayMs);
      addCampaignLog(campaign, `⏳ Outside allowed sending hours/days. Campaign paused until next valid window: ${wakeUpTime.toLocaleString()}`, 'info');
      campaign.nextSendTime = Date.now() + delayMs;
      saveDatabase();
      continue;
    }
    
    const recipientIndex = campaign.recipients.findIndex(r => r.status === 'PENDING');
    if (recipientIndex === -1) {
      campaign.status = 'COMPLETED';
      campaign.nextSendTime = null;
      saveDatabase();
      archiveCampaignRun(campaign, dateStr);
      addCampaignLog(campaign, '🎉 Campaign completed! All recipients have been processed. Campaign has stopped.', 'success');
      continue;
    }
    
    const recipient = campaign.recipients[recipientIndex];
    recipient.status = 'PROCESSING';
    saveDatabase();
    
    dispatchEmail(campaign, recipient, dateStr);
  }
}

async function dispatchEmail(campaign, recipient, dateStr) {
  let customizedSubject = campaign.subject;
  let customizedBody = campaign.body;
  
  const placeholders = {
    Name: recipient.name,
    Email: recipient.email,
    ...recipient.data
  };
  
  for (const [key, value] of Object.entries(placeholders)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
    customizedSubject = customizedSubject.replace(regex, value || '');
    customizedBody = customizedBody.replace(regex, value || '');
  }
  
  const wrappedHtmlBody = wrapEmailBody(customizedBody, recipient.id, db.settings.trackingUrl);
  
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
    addCampaignLog(campaign, `Sending email to ${recipient.name} <${recipient.email}>...`, 'info');
    
    const mailOptions = {
      from: `"${db.settings.smtpUser.split('@')[0]}" <${db.settings.smtpUser}>`,
      to: recipient.email,
      subject: customizedSubject,
      html: wrappedHtmlBody
    };
    
    await transporter.sendMail(mailOptions);
    
    recipient.status = 'SENT';
    recipient.sentAt = new Date().toISOString();
    recipient.error = null;
    campaign.sentCount++;
    addCampaignLog(campaign, `✓ Email successfully sent to ${recipient.name} <${recipient.email}>`, 'success');
  } catch (error) {
    recipient.status = 'FAILED';
    recipient.sentAt = new Date().toISOString();
    recipient.error = error.message;
    campaign.failedCount++;
    addCampaignLog(campaign, `✗ Failed to send email to ${recipient.name} <${recipient.email}>: ${error.message}`, 'error');
  }
  
  const delayMs = db.settings.intervalMinutes * 60 * 1000;
  campaign.nextSendTime = Date.now() + delayMs;
  saveDatabase();
}

// Start periodic processing (every 3 seconds)
setInterval(processRunningCampaigns, 3000);

// Load DB configurations and resume active campaigns
loadDatabase();

// API Route: Get Scheduled Campaigns List (for calendar indicators)
app.get('/api/campaigns/list', (req, res) => {
  const list = {};
  if (db.campaigns) {
    Object.keys(db.campaigns).forEach(date => {
      const camp = db.campaigns[date];
      if (camp.recipients && camp.recipients.length > 0) {
        list[date] = {
          status: camp.status,
          subject: camp.subject,
          count: camp.recipients.length
        };
      }
    });
  }
  res.json(list);
});

// API Route: Retrieve Campaign Status & Active Queue (date-wise)
app.get('/api/campaign/status', (req, res) => {
  const { date } = req.query;
  const campaign = getCampaignForDate(date);
  
  const responseData = {
    status: campaign.status,
    settings: {
      smtpUser: db.settings.smtpUser,
      smtpPass: db.settings.smtpPass ? '********' : '',
      intervalMinutes: db.settings.intervalMinutes,
      testEmail: db.settings.testEmail,
      trackingUrl: db.settings.trackingUrl || ''
    },
    campaign: {
      subject: campaign.subject,
      body: campaign.body,
      scheduleEnabled: campaign.scheduleEnabled || false,
      scheduleTime: campaign.scheduleTime || '09:00',
      scheduleAllowedStart: campaign.scheduleAllowedStart || '09:00',
      scheduleAllowedEnd: campaign.scheduleAllowedEnd || '18:00',
      scheduleDays: campaign.scheduleDays || [1, 2, 3, 4, 5],
      totalCount: campaign.totalCount,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      openedCount: campaign.openedCount || 0,
      clickedCount: campaign.clickedCount || 0,
      nextSendTime: campaign.nextSendTime,
      recipients: campaign.recipients,
      logs: campaign.logs
    }
  };
  res.json(responseData);
});

// API Route: Save Configuration
app.post('/api/settings', (req, res) => {
  const { smtpUser, smtpPass, intervalMinutes, testEmail, trackingUrl } = req.body;
  
  if (smtpUser !== undefined) db.settings.smtpUser = smtpUser;
  if (smtpPass && smtpPass !== '********') db.settings.smtpPass = smtpPass;
  if (intervalMinutes !== undefined) {
    db.settings.intervalMinutes = Math.max(0.05, parseFloat(intervalMinutes));
  }
  if (testEmail !== undefined) db.settings.testEmail = testEmail;
  if (trackingUrl !== undefined) db.settings.trackingUrl = trackingUrl.trim();
  
  saveDatabase();
  res.json({
    success: true,
    settings: {
      smtpUser: db.settings.smtpUser,
      smtpPass: db.settings.smtpPass ? '********' : '',
      intervalMinutes: db.settings.intervalMinutes,
      testEmail: db.settings.testEmail,
      trackingUrl: db.settings.trackingUrl || ''
    }
  });
});

// API Route: Verify SMTP Connection
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
    await transporter.verify();
    await transporter.sendMail({
      from: `"${user.split('@')[0]}" <${user}>`,
      to: toEmail,
      subject: 'Gmail Marketing System - Connection Test Successful',
      text: `Hello!\n\nThis is a verification check from your Gmail Marketing application. Your SMTP connections are working properly!\n\nVerified at: ${new Date().toLocaleString()}`
    });
    res.json({ success: true, message: `Successfully connected to Gmail SMTP and sent test email to ${toEmail}.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API Route: Process Excel or CSV Recipient sheets (date-wise)
app.post('/api/upload-recipients', upload.single('file'), (req, res) => {
  try {
    const { date } = req.query;
    if (!req.file) {
      return res.status(400).json({ error: 'Please choose and upload a sheet file.' });
    }
    
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = xlsx.utils.sheet_to_json(worksheet);
    
    if (rawRows.length === 0) {
      return res.status(400).json({ error: 'The uploaded file is empty or cannot be parsed.' });
    }
    
    const keys = Object.keys(rawRows[0]);
    let emailKey = null;
    let nameKey = null;
    
    for (const key of keys) {
      if (!emailKey && /email|mail/i.test(key)) emailKey = key;
      if (!nameKey && /name|fullname|contact/i.test(key)) nameKey = key;
    }
    
    if (!emailKey) {
      return res.status(400).json({ error: 'No column matched "Email". Ensure a column named "Email" is defined.' });
    }
    
    const recipients = [];
    for (const row of rawRows) {
      const email = String(row[emailKey] || '').trim();
      if (!email) continue;
      
      const name = nameKey ? String(row[nameKey] || '').trim() : 'Subscriber';
      const data = {};
      for (const [k, v] of Object.entries(row)) {
        data[k] = String(v || '').trim();
      }
      
      recipients.push({
        id: generateId(),
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
    
    const campaign = getCampaignForDate(date);
    campaign.status = 'IDLE';
    campaign.recipients = [...(campaign.recipients || []), ...recipients];
    deduplicateRecipients(campaign);
    campaign.totalCount = campaign.recipients.length;
    campaign.nextSendTime = null;
    
    addCampaignLog(campaign, `Uploaded ${recipients.length} recipients (Auto-detected email: "${emailKey}", name: "${nameKey || 'None'}").`, 'info');
    
    saveDatabase();
    res.json({ success: true, count: recipients.length });
  } catch (error) {
    res.status(500).json({ error: 'Error processing upload: ' + error.message });
  }
});

// API Route: Initiate or Resume Campaign
app.post('/api/campaign/start', (req, res) => {
  const { date, subject, body, scheduleEnabled, scheduleTime, scheduleAllowedStart, scheduleAllowedEnd, scheduleDays } = req.body;
  
  if (!db.settings.smtpUser || !db.settings.smtpPass) {
    return res.status(400).json({ error: 'Gmail connection settings are not configured yet.' });
  }
  
  const campaign = getCampaignForDate(date);
  if (campaign.recipients.length === 0) {
    return res.status(400).json({ error: 'The campaign recipient queue is empty. Upload a CSV/Excel sheet first.' });
  }
  
  if (!subject || !body) {
    return res.status(400).json({ error: 'Please enter a Subject and Email Body to proceed.' });
  }
  
  campaign.subject = subject;
  campaign.body = body;
  
  if (scheduleEnabled !== undefined) campaign.scheduleEnabled = !!scheduleEnabled;
  if (scheduleTime !== undefined) campaign.scheduleTime = scheduleTime;
  if (scheduleAllowedStart !== undefined) campaign.scheduleAllowedStart = scheduleAllowedStart;
  if (scheduleAllowedEnd !== undefined) campaign.scheduleAllowedEnd = scheduleAllowedEnd;
  if (scheduleDays !== undefined) campaign.scheduleDays = Array.isArray(scheduleDays) ? scheduleDays.map(Number) : [1, 2, 3, 4, 5];

  if (campaign.status === 'IDLE' || campaign.status === 'COMPLETED') {
    const hasPending = campaign.recipients.some(r => r.status === 'PENDING');
    if (!hasPending) {
      campaign.sentCount = 0;
      campaign.failedCount = 0;
      campaign.openedCount = 0;
      campaign.clickedCount = 0;
      campaign.recipients.forEach(r => {
        r.status = 'PENDING';
        r.sentAt = null;
        r.error = null;
        r.opened = false;
        r.openedAt = null;
        r.opensCount = 0;
        r.clicks = [];
      });
      deduplicateRecipients(campaign);
      campaign.logs = [];
      addCampaignLog(campaign, 'Starting email campaign deployment...', 'info');
    } else {
      addCampaignLog(campaign, 'Resuming email campaign deployment with new pending recipients...', 'info');
    }
  } else if (campaign.status === 'PAUSED') {
    addCampaignLog(campaign, 'Resuming current paused email campaign...', 'info');
  }
  
  campaign.status = 'RUNNING';
  saveDatabase();
  res.json({ success: true });
});

// API Route: Save Campaign Settings & Content (Draft)
app.post('/api/campaign/save', (req, res) => {
  const { date, subject, body, scheduleEnabled, scheduleTime, scheduleAllowedStart, scheduleAllowedEnd, scheduleDays } = req.body;
  
  const campaign = getCampaignForDate(date);
  
  if (subject !== undefined) campaign.subject = subject;
  if (body !== undefined) campaign.body = body;
  
  if (scheduleEnabled !== undefined) campaign.scheduleEnabled = !!scheduleEnabled;
  if (scheduleTime !== undefined) campaign.scheduleTime = scheduleTime;
  if (scheduleAllowedStart !== undefined) campaign.scheduleAllowedStart = scheduleAllowedStart;
  if (scheduleAllowedEnd !== undefined) campaign.scheduleAllowedEnd = scheduleAllowedEnd;
  if (scheduleDays !== undefined) campaign.scheduleDays = Array.isArray(scheduleDays) ? scheduleDays.map(Number) : [1, 2, 3, 4, 5];
  
  addCampaignLog(campaign, 'Campaign draft and schedule settings saved.', 'info');
  saveDatabase();
  res.json({ success: true });
});

// API Route: Pause Campaign
app.post('/api/campaign/stop', (req, res) => {
  const { date } = req.body;
  const campaign = getCampaignForDate(date);
  campaign.status = 'PAUSED';
  campaign.nextSendTime = null;
  addCampaignLog(campaign, 'Campaign paused by the operator.', 'info');
  saveDatabase();
  res.json({ success: true });
});

// API Route: Reset Campaign Queue
app.post('/api/campaign/reset', (req, res) => {
  const { date } = req.body;
  const campaign = getCampaignForDate(date);
  campaign.status = 'IDLE';
  campaign.nextSendTime = null;
  campaign.sentCount = 0;
  campaign.failedCount = 0;
  campaign.openedCount = 0;
  campaign.clickedCount = 0;
  campaign.recipients.forEach(r => {
    r.status = 'PENDING';
    r.sentAt = null;
    r.error = null;
    r.opened = false;
    r.openedAt = null;
    r.opensCount = 0;
    r.clicks = [];
  });
  deduplicateRecipients(campaign);
  campaign.logs = [];
  addCampaignLog(campaign, 'Campaign settings and recipient queue metrics have been reset.', 'info');
  saveDatabase();
  res.json({ success: true });
});

// API Route: Clear Campaign Recipients entirely
app.post('/api/campaign/clear', (req, res) => {
  const { date } = req.body;
  const campaign = getCampaignForDate(date);
  
  if (campaign.recipients && campaign.recipients.length > 0 && (campaign.sentCount > 0 || campaign.failedCount > 0)) {
    archiveCampaignRun(campaign, date);
  }
  
  campaign.status = 'IDLE';
  campaign.nextSendTime = null;
  campaign.totalCount = 0;
  campaign.sentCount = 0;
  campaign.failedCount = 0;
  campaign.openedCount = 0;
  campaign.clickedCount = 0;
  campaign.recipients = [];
  campaign.logs = [];
  addCampaignLog(campaign, 'Campaign recipient list cleared.', 'info');
  saveDatabase();
  res.json({ success: true });
});

// API Route: Export Campaign Report (CSV)
app.get('/api/campaign/export', (req, res) => {
  try {
    const { date, startDate, endDate, clientType, company, city } = req.query;
    const campaign = getCampaignForDate(date);
    let recipients = campaign.recipients || [];
    
    if (startDate) {
      const start = new Date(startDate);
      recipients = recipients.filter(r => r.sentAt && new Date(r.sentAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      recipients = recipients.filter(r => r.sentAt && new Date(r.sentAt) <= end);
    }
    if (clientType) {
      const ctLower = clientType.toLowerCase().trim();
      recipients = recipients.filter(r => {
        if (!r.data) return false;
        const typeKey = Object.keys(r.data).find(k => /type/i.test(k));
        return typeKey && String(r.data[typeKey]).toLowerCase().includes(ctLower);
      });
    }
    if (company) {
      const compLower = company.toLowerCase().trim();
      recipients = recipients.filter(r => {
        if (!r.data) return false;
        const companyKey = Object.keys(r.data).find(k => /company/i.test(k));
        return companyKey && String(r.data[companyKey]).toLowerCase().includes(compLower);
      });
    }
    if (city) {
      const cityLower = city.toLowerCase().trim();
      recipients = recipients.filter(r => {
        if (!r.data) return false;
        const cityKey = Object.keys(r.data).find(k => /city/i.test(k));
        return cityKey && String(r.data[cityKey]).toLowerCase().includes(cityLower);
      });
    }
    
    if (recipients.length === 0) {
      return res.status(400).send('No recipient data matched the filters to export.');
    }
    
    const csv = generateCSV(recipients);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=campaign_report_${date}.csv`);
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
  
  let recipient = null;
  let campaign = null;
  if (db.campaigns) {
    for (const dateStr of Object.keys(db.campaigns)) {
      const camp = db.campaigns[dateStr];
      const r = camp.recipients.find(rec => rec.id === recipientId);
      if (r) {
        recipient = r;
        campaign = camp;
        break;
      }
    }
  }
  
  if (recipient && campaign) {
    if (!recipient.opened) {
      recipient.opened = true;
      recipient.openedAt = new Date().toISOString();
      campaign.openedCount = (campaign.openedCount || 0) + 1;
      addCampaignLog(campaign, `[Track] Email opened by ${recipient.name} <${recipient.email}>`, 'success');
    }
    recipient.opensCount = (recipient.opensCount || 0) + 1;
    saveDatabase();
  }
  
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
  
  let recipient = null;
  let campaign = null;
  if (db.campaigns) {
    for (const dateStr of Object.keys(db.campaigns)) {
      const camp = db.campaigns[dateStr];
      const r = camp.recipients.find(rec => rec.id === recipientId);
      if (r) {
        recipient = r;
        campaign = camp;
        break;
      }
    }
  }
  
  if (recipient && campaign) {
    if (!recipient.clicks) recipient.clicks = [];
    recipient.clicks.push({
      url: targetUrl,
      clickedAt: new Date().toISOString()
    });
    
    const isFirstClick = recipient.clicks.length === 1;
    if (isFirstClick) {
      campaign.clickedCount = (campaign.clickedCount || 0) + 1;
    }
    
    addCampaignLog(campaign, `[Track] Link clicked by ${recipient.name} <${recipient.email}>: ${targetUrl}`, 'success');
    saveDatabase();
  }
  
  res.redirect(targetUrl);
});

app.listen(PORT, () => {
  console.log(`Gmail Marketing application engine running on port ${PORT}`);
});
